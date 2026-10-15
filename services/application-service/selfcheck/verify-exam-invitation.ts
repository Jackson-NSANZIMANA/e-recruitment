// ══════════════════════════════════════════════════════════════════
// application-service — The citizen's exam QR, LIVE (ADR-033)
//
// Proves against PostgreSQL that:
//   • the slot projection persists the signed invitation exactly as signed;
//   • the owner-scoped read hands it back as the QR payload, and that payload
//     VERIFIES offline with the scheduling public key (what a venue does);
//   • no QR before a slot (PENDING), none during a late hold (ON_HOLD), none
//     for a stranger (404) or an officer token (403);
//   • the token is write-once, and a redelivery backfills a pre-ADR-033 row
//     without ever replacing an issued token.
//
//   set -a; . ./.env; set +a
//   pnpm --filter @usrp/application-service exec tsx selfcheck/verify-exam-invitation.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { InMemoryEventBus, newCorrelationContext } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair, signSlotInvitation, verifySlotInvitation } from '@usrp/shared-security';
import type { SlotInvitationClaims } from '@usrp/shared-types';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import {
  ExamInvitationService,
  PgApplicationRepository,
  PgExamInvitationReader,
  ProjectSlotAssignmentService,
  examInvitationRoute,
} from '../src/index.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const AUTH = generateDeviceKeyPair();
const QR_KEY = generateDeviceKeyPair(); // stands in for scheduling's invitation key
const CITIZEN = 'b7000000-0000-4000-8000-000000000001';
const STRANGER = 'b7000000-0000-4000-8000-000000000002';
const CAMPAIGN = 'b7000000-0000-4000-8000-0000000000c1';
const APP_GREEN = 'b7000000-0000-4000-8000-00000000a001';
const APP_LEGACY = 'b7000000-0000-4000-8000-00000000a002';
const APP_PENDING = 'b7000000-0000-4000-8000-00000000a003';
const APPS = [APP_GREEN, APP_LEGACY, APP_PENDING];
const SLOT = 'b7000000-0000-4000-8000-0000000000e1';
const EXAM_DATE = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function bearer(kind: 'system' | 'officer'): string {
  const base = { v: 1 as const, iss: 'usrp', aud: 'usrp-services', sub: kind === 'system' ? 'selfcheck-system' : 'b7000000-0000-4000-8000-00000000ff01', issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z' };
  const claims: AuthTokenClaims = kind === 'officer' ? { ...base, kind, agency: 'RDF', roles: ['reviewer'] } : { ...base, kind };
  return signAuthToken(AUTH.privateKeyPem, claims);
}

function mint(applicationId: string, ticketId: string): string {
  const claims: SlotInvitationClaims = {
    v: 1, keyId: 'selfcheck-qr', ticketId, applicationId, applicantId: CITIZEN, agency: 'RDF',
    campaignId: CAMPAIGN, slotId: SLOT, venueName: 'ULK Stadium', examDate: EXAM_DATE, reportingTimeHour: 8,
    issuedAt: new Date().toISOString(), expiresAt: `${EXAM_DATE}T23:59:59.000Z`,
  };
  return signSlotInvitation(QR_KEY.privateKeyPem, claims);
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id IN ${tx(APPS)}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id IN ${tx(APPS)}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx([CITIZEN, STRANGER])}`;
  });
}

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    for (const [id, hash] of [[CITIZEN, 'b7'.repeat(32)], [STRANGER, 'b8'.repeat(32)]] as const) {
      await tx`INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth, encrypted_home_district,
         encrypted_home_province, gender, registration_channel, identity_status)
        VALUES (${id}, ${hash}, 'x','x','x','x','MALE','WEB','VERIFIED'::public_core.identity_verification_status)`;
    }
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO public_core.recruitment_campaigns
      (id, public_code, campaign_label, agency, status, target_categories, registration_opens_at,
       registration_closes_at, examination_start_date, examination_end_date, examination_reporting_hour)
      VALUES (${CAMPAIGN}, 'RDF-QR-SELFCHECK', 'RDF General Enlistment (QR proof)', 'RDF', 'REGISTRATION_OPEN',
              '["GENERAL_ENLISTMENT"]', now() - interval '1 day', now() + interval '30 days', ${EXAM_DATE}, ${EXAM_DATE}, 8)`;
    await tx`INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
      VALUES (${APP_GREEN}, 'RDF-97401', ${CITIZEN}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT', 'DOCUMENT_REVIEW_GREEN'),
             (${APP_PENDING}, 'RDF-97403', ${CITIZEN}, ${CAMPAIGN}, 'RESERVE_FORCE_ALEVEL', 'ACADEMIC_VETTING')`;
    // A pre-ADR-033 assignment: SLOT_ASSIGNED with a ticket but no stored token.
    await tx`INSERT INTO rdf_ops.applications
      (id, processing_code, applicant_id, campaign_id, category, status, venue_assignment_id, qr_invitation_code,
       assigned_venue_name, physical_test_scheduled_at)
      VALUES (${APP_LEGACY}, 'RDF-97402', ${CITIZEN}, ${CAMPAIGN}, 'RESERVE_FORCE_UNIVERSITY', 'SLOT_ASSIGNED',
              ${SLOT}, 'TKT-LEGACY', 'ULK Stadium', ${EXAM_DATE}::date)`;
  });
}

async function main(): Promise<void> {
  console.log('\n══ application-service — the citizen exam QR (LIVE, ADR-033) ══');
  await cleanup();
  await seed();
  const projector = new ProjectSlotAssignmentService({ repository: new PgApplicationRepository(), eventBus: new InMemoryEventBus() });
  const service = new ExamInvitationService({ reader: new PgExamInvitationReader() });
  const verify = makeAuthVerifier({ publicKeyPem: AUTH.publicKeyPem, issuer: 'usrp', audience: 'usrp-services' });
  const server = await startHttpServer({ serviceName: 'exam-invitation-selfcheck', port: 0, host: '127.0.0.1', routes: [examInvitationRoute(service, verify)], handleSignals: false });

  const read = async (applicantId: string, applicationId: string, kind: 'system' | 'officer' = 'system'): Promise<{ status: number; json: Record<string, unknown>; text: string }> => {
    const res = await fetch(`${server.url}/v1/applications/exam-invitation/by-applicant?applicantId=${applicantId}&applicationId=${applicationId}`, {
      headers: { authorization: `Bearer ${bearer(kind)}` },
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, text };
  };
  const project = (applicationId: string, ticketId: string, token: string): ReturnType<ProjectSlotAssignmentService['project']> =>
    projector.project({
      result: { applicationId, agency: 'RDF', venueAssignmentId: SLOT, assignedDistrict: 'GASABO', assignedVenueName: 'ULK Stadium', examDate: EXAM_DATE, qrInvitationCode: ticketId, qrSignedToken: token, correlationId: newCorrelationContext().correlationId },
      agency: 'RDF',
      context: newCorrelationContext(),
    });

  try {
    console.log('\n── 1. Before a slot there is no QR ──');
    const before = await read(CITIZEN, APP_GREEN);
    check('green but unscheduled → 200 PENDING, no payload', before.status === 200 && before.json['state'] === 'PENDING' && !before.text.includes('qrPayload'), before.text);
    check('still vetting → PENDING', (await read(CITIZEN, APP_PENDING)).json['state'] === 'PENDING');

    console.log('\n── 2. Slot assigned: the signed token is persisted and handed back ──');
    const token = mint(APP_GREEN, 'TKT-GREEN-1');
    const applied = await project(APP_GREEN, 'TKT-GREEN-1', token);
    check('projection APPLIED (DOCUMENT_REVIEW_GREEN → SLOT_ASSIGNED)', applied.kind === 'APPLIED', applied.kind);
    const stored = await admin<{ t: string | null }[]>`SELECT qr_signed_token AS t FROM rdf_ops.applications WHERE id = ${APP_GREEN}`;
    check('the exact signed token is stored', stored[0]?.t === token);
    const ready = await read(CITIZEN, APP_GREEN);
    const inv = ready.json['invitation'] as Record<string, unknown> | undefined;
    check('owner read → READY with the QR payload', ready.status === 200 && ready.json['state'] === 'READY' && inv?.['qrPayload'] === token, ready.text);
    const claims = verifySlotInvitation(QR_KEY.publicKeyPem, String(inv?.['qrPayload'] ?? ''));
    check('the payload VERIFIES offline with the scheduling public key (what the venue does)', claims !== null && claims.applicationId === APP_GREEN && claims.ticketId === 'TKT-GREEN-1');
    check('display fields: venue, exam date, reporting hour, validity, processing code, campaign',
      inv?.['venueName'] === 'ULK Stadium' && inv['examDate'] === EXAM_DATE && inv['reportingTimeHour'] === 8 &&
      inv['validUntil'] === `${EXAM_DATE}T23:59:59.000Z` && ready.json['processingCode'] === 'RDF-97401' &&
      ready.json['campaignLabel'] === 'RDF General Enlistment (QR proof)');
    check('no PII in the body (no applicant id, national id hash or name)', !ready.text.includes(CITIZEN) && !ready.text.includes('b7b7b7b7'));

    console.log('\n── 3. Scope ──');
    check("a stranger asking for this application → 404", (await read(STRANGER, APP_GREEN)).status === 404);
    check('an officer token on the system read → 403', (await read(CITIZEN, APP_GREEN, 'officer')).status === 403);

    console.log('\n── 4. Write-once, and backfill for a pre-ADR-033 assignment ──');
    let refused = false;
    try {
      await admin`UPDATE rdf_ops.applications SET qr_signed_token = ${mint(APP_GREEN, 'TKT-FORGED')} WHERE id = ${APP_GREEN}`;
    } catch (err) {
      refused = (err as { code?: string }).code === '23514';
    }
    check('replacing an issued token is refused by the engine, even as admin (23514)', refused);
    const replay = await project(APP_GREEN, 'TKT-GREEN-1', mint(APP_GREEN, 'TKT-GREEN-1'));
    check('a redelivered assignment is NO_CHANGE and keeps the FIRST token',
      replay.kind === 'NO_CHANGE' && (await admin<{ t: string }[]>`SELECT qr_signed_token AS t FROM rdf_ops.applications WHERE id = ${APP_GREEN}`)[0]?.t === token);
    check('a legacy assignment with no token → UNAVAILABLE (no QR invented)', (await read(CITIZEN, APP_LEGACY)).json['state'] === 'UNAVAILABLE');
    const legacyToken = mint(APP_LEGACY, 'TKT-LEGACY');
    await project(APP_LEGACY, 'TKT-LEGACY', legacyToken);
    check('a redelivery of the SAME assignment backfills it → READY', (await read(CITIZEN, APP_LEGACY)).json['state'] === 'READY');
    let shapeRefused = false;
    try {
      await admin`UPDATE rdf_ops.applications SET qr_signed_token = 'not-a-token' WHERE id = ${APP_PENDING}`;
    } catch (err) {
      shapeRefused = (err as { code?: string }).code === '23514';
    }
    check('a value that is not a USRP-SLOT.v1 token is refused by the shape CHECK', shapeRefused);

    console.log('\n── 5. A late hold withholds the QR ──');
    await admin`UPDATE rdf_ops.applications SET status = 'ADJUDICATION_REVIEW' WHERE id = ${APP_GREEN}`;
    const held = await read(CITIZEN, APP_GREEN);
    check('ADJUDICATION_REVIEW → ON_HOLD and NO payload even though a token is stored', held.json['state'] === 'ON_HOLD' && !held.text.includes('qrPayload'), held.text);
  } finally {
    await cleanup();
    await server.stop();
    await admin.end();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('CITIZEN EXAM QR PROVEN (live) ✓');
  else {
    console.error(`${String(failures)} assertion(s) FAILED`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('SELF-CHECK CRASHED:', err);
  process.exit(1);
});
