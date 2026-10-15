// ══════════════════════════════════════════════════════════════════
// application-service — Document checklist + venue verification (LIVE, ADR-032)
//
// Owner decisions of 2026-10-14, proven against PostgreSQL:
//   • ADVISORY — reading the checklist or clearing a document never moves an
//     application's status;
//   • an automated registry verification waives the paper;
//   • only the front-door check-in post (document.verify.venue) clears a paper
//     at the venue; the fact is attributed, audited once, write-once, and a
//     re-scan is idempotent (uq_rdf_docs_venue_once);
//   • the bound policy version's list wins over the ground-truth table;
//   • scopes hold: a sibling agency's officer and a stranger citizen see 404.
//
//   set -a; . ./.env; set +a
//   pnpm --filter @usrp/application-service exec tsx selfcheck/verify-document-checklist.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import {
  DocumentChecklistService,
  PgDocumentChecklistRepository,
  documentChecklistRoutes,
} from '../src/index.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const KEYS = generateDeviceKeyPair();
const CITIZEN = 'b5000000-0000-4000-8000-000000000001';
const STRANGER = 'b5000000-0000-4000-8000-000000000002';
const CAMPAIGN = 'b5000000-0000-4000-8000-0000000000c1';
const POLICY = 'b5000000-0000-4000-8000-0000000000d1';
const APP_BOUND = 'b5000000-0000-4000-8000-00000000a001';
const APP_LEGACY = 'b5000000-0000-4000-8000-00000000a002';
const APP_DONE = 'b5000000-0000-4000-8000-00000000a003';
const APPS = [APP_BOUND, APP_LEGACY, APP_DONE];
const CHECKIN_OFFICER = 'b5000000-0000-4000-8000-00000000ff01';
const REVIEWER = 'b5000000-0000-4000-8000-00000000ff02';
const RNP_OFFICER = 'b5000000-0000-4000-8000-00000000ff03';
const POLICY_REQUIRED = ['NATIONAL_ID', 'GOOD_CONDUCT_CERTIFICATE', 'NON_CONVICTION_CERTIFICATE'];

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function token(kind: 'officer' | 'system', sub: string, agency: 'RDF' | 'RNP' = 'RDF', roles: string[] = []): string {
  const base = { v: 1 as const, iss: 'usrp', aud: 'usrp-services', sub, issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z' };
  const claims: AuthTokenClaims = kind === 'officer' ? { ...base, kind, agency, roles } : { ...base, kind };
  return signAuthToken(KEYS.privateKeyPem, claims);
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.document_records WHERE application_id IN ${tx(APPS)}`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id IN ${tx(APPS)}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id IN ${tx(APPS)}`;
    await tx`UPDATE public_core.recruitment_campaigns SET current_policy_version_id = NULL WHERE id = ${CAMPAIGN}`;
    await tx`DELETE FROM public_core.campaign_policy_versions WHERE id = ${POLICY}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx([CITIZEN, STRANGER])}`;
  });
}

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    for (const [id, hash] of [[CITIZEN, 'b5'.repeat(32)], [STRANGER, 'b6'.repeat(32)]] as const) {
      await tx`
        INSERT INTO public_core.applicant_identities
          (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
           encrypted_home_district, encrypted_home_province, gender,
           registration_channel, identity_status)
        VALUES (${id}, ${hash}, 'x','x','x','x','MALE','WEB','VERIFIED'::public_core.identity_verification_status)`;
    }
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO public_core.recruitment_campaigns
        (id, public_code, campaign_label, agency, status, target_categories,
         registration_opens_at, registration_closes_at, examination_start_date,
         examination_end_date, examination_reporting_hour)
      VALUES (${CAMPAIGN}, 'RDF-CHECKLIST-A', 'checklist', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
              now() - interval '1 day', now() + interval '30 days', '2026-12-01', '2026-12-10', 7)`;
    await tx`
      INSERT INTO public_core.campaign_policy_versions
        (id, campaign_id, agency, version_number, policy_document, policy_hash,
         hash_version, legal_basis_code, legal_basis_reference, created_by)
      VALUES (${POLICY}, ${CAMPAIGN}, 'RDF', 1,
              ${tx.json({ GENERAL_ENLISTMENT: { requiredDocumentTypes: POLICY_REQUIRED } })},
              ${'c'.repeat(64)}, 1, 'TEST', 'selfcheck', ${CHECKIN_OFFICER})`;
    await tx`
      INSERT INTO rdf_ops.applications
        (id, processing_code, applicant_id, campaign_id, category, status, policy_version_id)
      VALUES
        (${APP_BOUND}, 'RDF-97301', ${CITIZEN}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT', 'SUBMITTED', ${POLICY}),
        (${APP_LEGACY}, 'RDF-97302', ${CITIZEN}, ${CAMPAIGN}, 'RESERVE_FORCE_ALEVEL', 'SUBMITTED', NULL),
        (${APP_DONE}, 'RDF-97303', ${CITIZEN}, ${CAMPAIGN}, 'RESERVE_FORCE_UNIVERSITY', 'WITHDRAWN', NULL)`;
  });
}

async function main(): Promise<void> {
  console.log('\n══ application-service — document checklist + venue verification (LIVE, ADR-032) ══');
  await cleanup();
  await seed();
  const bus = new InMemoryEventBus();
  const service = new DocumentChecklistService({ repository: new PgDocumentChecklistRepository(), eventBus: bus });
  const verify = makeAuthVerifier({ publicKeyPem: KEYS.publicKeyPem, issuer: 'usrp', audience: 'usrp-services' });
  const server = await startHttpServer({
    serviceName: 'document-checklist-selfcheck', port: 0, host: '127.0.0.1',
    routes: documentChecklistRoutes(service, verify), handleSignals: false,
  });

  const checkin = token('officer', CHECKIN_OFFICER, 'RDF', ['screening_officer']);
  const reviewer = token('officer', REVIEWER, 'RDF', ['reviewer']);
  const rnp = token('officer', RNP_OFFICER, 'RNP', ['reviewer', 'screening_officer']);
  const system = token('system', 'selfcheck-system');

  async function call(method: 'GET' | 'POST', path: string, bearer: string, body?: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { json = {}; }
    return { status: res.status, text, json };
  }
  const items = (json: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(((json['items'] as { documentType: string; satisfaction: string }[] | undefined) ?? []).map((i) => [i.documentType, i.satisfaction]));
  const statusOf = async (app: string): Promise<string | undefined> =>
    (await admin<{ status: string }[]>`SELECT status::text FROM rdf_ops.applications WHERE id = ${app}`)[0]?.status;

  try {
    console.log('\n── 1. The bound policy list wins; an automated verification waives the paper ──');
    const first = await call('GET', `/v1/applications/document-checklist?applicationId=${APP_BOUND}`, reviewer);
    check('officer read → 200', first.status === 200, first.text);
    check('source = POLICY_VERSION', first.json['source'] === 'POLICY_VERSION');
    check('exactly the policy list (not the ground-truth table)',
      Object.keys(items(first.json)).sort().join() === [...POLICY_REQUIRED].sort().join(), first.text);
    check('NATIONAL_ID is API_VERIFIED (NIDA) with nothing uploaded', items(first.json)['NATIONAL_ID'] === 'API_VERIFIED');
    check('GOOD_CONDUCT_CERTIFICATE is MISSING (no registry confirms it)', items(first.json)['GOOD_CONDUCT_CERTIFICATE'] === 'MISSING');
    check('not complete — and advisory: the application did not move', first.json['complete'] === false && (await statusOf(APP_BOUND)) === 'SUBMITTED');
    check('no forensic score, flags, object key or officer id in the body',
      !/score|flag|minio|object|venue_verified_by|officer/i.test(first.text), first.text);

    console.log('\n── 2. Only the check-in post clears a paper at the venue ──');
    const denied = await call('POST', '/v1/applications/documents/verify-at-venue', reviewer, { applicationId: APP_BOUND, documentType: 'GOOD_CONDUCT_CERTIFICATE' });
    check('a reviewer is refused (403 PERMISSION_DENIED)', denied.status === 403 && denied.json['error'] === 'PERMISSION_DENIED', denied.text);
    const ok = await call('POST', '/v1/applications/documents/verify-at-venue', checkin, { applicationId: APP_BOUND, documentType: 'GOOD_CONDUCT_CERTIFICATE' });
    check('the check-in officer → 200 RECORDED', ok.status === 200 && ok.json['status'] === 'RECORDED', ok.text);
    check('…and the returned checklist shows VENUE_VERIFIED',
      items(ok.json['checklist'] as Record<string, unknown>)['GOOD_CONDUCT_CERTIFICATE'] === 'VENUE_VERIFIED');
    const again = await call('POST', '/v1/applications/documents/verify-at-venue', checkin, { applicationId: APP_BOUND, documentType: 'GOOD_CONDUCT_CERTIFICATE' });
    check('a re-scan → 200 ALREADY_RECORDED (idempotent)', again.status === 200 && again.json['status'] === 'ALREADY_RECORDED');
    const venueRows = await admin<{ by: string; at: Date | null; key: string | null }[]>`
      SELECT venue_verified_by_id::text AS by, venue_verified_at AS at, minio_object_key AS key
      FROM rdf_ops.document_records WHERE application_id = ${APP_BOUND} AND document_type = 'GOOD_CONDUCT_CERTIFICATE'`;
    check('exactly ONE row, attributed to the officer, with no object', venueRows.length === 1 && venueRows[0]?.by === CHECKIN_OFFICER && venueRows[0]?.at !== null && venueRows[0]?.key === null, JSON.stringify(venueRows));
    const audits = bus.published.filter((e) => (e as { action?: string }).action === 'DOCUMENT_VERIFIED_AT_VENUE');
    check('audited ONCE (the re-scan wrote nothing)', audits.length === 1);
    check('still advisory: the application did not move', (await statusOf(APP_BOUND)) === 'SUBMITTED');

    console.log('\n── 3. The engine holds the line ──');
    let refused = false;
    try {
      await admin`UPDATE rdf_ops.document_records SET venue_verified_by_id = ${REVIEWER} WHERE application_id = ${APP_BOUND} AND document_type = 'GOOD_CONDUCT_CERTIFICATE'`;
    } catch (err) {
      refused = (err as { code?: string }).code === '23514';
    }
    check('re-attributing a venue verification is refused even as admin (23514)', refused);
    const idx = await admin<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE schemaname = 'rdf_ops' AND indexname = 'uq_rdf_docs_venue_once'`;
    check('uq_rdf_docs_venue_once exists, unique, partial on venue_verified_by_id',
      /UNIQUE/.test(idx[0]?.indexdef ?? '') && /venue_verified_by_id IS NOT NULL/.test(idx[0]?.indexdef ?? ''), idx[0]?.indexdef);

    console.log('\n── 4. Refusals are closed and specific ──');
    const notRequired = await call('POST', '/v1/applications/documents/verify-at-venue', checkin, { applicationId: APP_BOUND, documentType: 'OLEVEL_CERTIFICATE' });
    check('a type not on this application\'s list → 422 NOT_REQUIRED', notRequired.status === 422 && notRequired.json['error'] === 'NOT_REQUIRED', notRequired.text);
    const unknown = await call('POST', '/v1/applications/documents/verify-at-venue', checkin, { applicationId: APP_BOUND, documentType: 'PASSPORT' });
    check('an unknown type → 400', unknown.status === 400);
    const done = await call('POST', '/v1/applications/documents/verify-at-venue', checkin, { applicationId: APP_DONE, documentType: 'NATIONAL_ID' });
    check('a withdrawn application → 409 NOT_APPLICABLE', done.status === 409 && done.json['error'] === 'NOT_APPLICABLE', done.text);

    console.log('\n── 5. Fallback and scopes ──');
    const legacy = await call('GET', `/v1/applications/document-checklist?applicationId=${APP_LEGACY}`, reviewer);
    check('no bound policy → source GROUND_TRUTH_TABLE (the announcements)', legacy.json['source'] === 'GROUND_TRUTH_TABLE', legacy.text);
    const sibling = await call('GET', `/v1/applications/document-checklist?applicationId=${APP_BOUND}`, rnp);
    check("an RNP officer reading an RDF application → 404", sibling.status === 404);
    const siblingVenue = await call('POST', '/v1/applications/documents/verify-at-venue', rnp, { applicationId: APP_BOUND, documentType: 'NATIONAL_ID' });
    check('…and cannot clear its documents (404)', siblingVenue.status === 404);
    const mine = await call('GET', `/v1/applications/document-checklist/by-applicant?applicantId=${CITIZEN}&applicationId=${APP_BOUND}`, system);
    check('citizen scope (system bridge) → 200 for their own application', mine.status === 200 && items(mine.json)['GOOD_CONDUCT_CERTIFICATE'] === 'VENUE_VERIFIED', mine.text);
    const theirs = await call('GET', `/v1/applications/document-checklist/by-applicant?applicantId=${STRANGER}&applicationId=${APP_BOUND}`, system);
    check('a stranger → 404 (same as nonexistent)', theirs.status === 404);
    const officerOnSystem = await call('GET', `/v1/applications/document-checklist/by-applicant?applicantId=${CITIZEN}&applicationId=${APP_BOUND}`, checkin);
    check('an officer token on the system bridge → 403', officerOnSystem.status === 403);
  } finally {
    await cleanup();
    await server.stop();
    await admin.end();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('DOCUMENT CHECKLIST + VENUE VERIFICATION PROVEN (live) ✓');
  else {
    console.error(`${String(failures)} assertion(s) FAILED`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('SELF-CHECK CRASHED:', err);
  process.exit(1);
});
