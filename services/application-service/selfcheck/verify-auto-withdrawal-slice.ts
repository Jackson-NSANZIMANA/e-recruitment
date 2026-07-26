// ══════════════════════════════════════════════════════════════════
// application-service — Live auto-withdrawal self-check (ADR-017)
//
// Proves WITHDRAWN's first writer end-to-end against live infrastructure:
// a REAL officer accept (HTTP, officer DB role, accept-lock and all) emits
// APPLICATION_ACCEPTED; the withdrawal projection — subscribed on the same
// bus, exactly as in production — retires every OTHER in-flight application
// of the accepted citizen across ALL THREE agency schemas as
// usrp_system_service (owner D6: all agencies, all campaigns, adjudication
// holds included).
//
// What it asserts:
//   • accept → 200 APPLIED emits one PII-free APPLICATION_ACCEPTED carrying
//     the applicant/campaign/category read under the accept's own lock;
//   • the same-agency sibling (SUBMITTED), a sibling-agency in-flight row
//     (SLOT_ASSIGNED), and an ADJUDICATION_REVIEW hold (D6) → WITHDRAWN;
//   • terminal rows are untouched: the already-REJECTED sibling stays
//     REJECTED, the accepted row stays ACCEPTED;
//   • each withdrawal appends ONE status-history row (from the true prior
//     status, performed_by 'SYSTEM') and emits ONE APPLICATION_WITHDRAWN
//     audit against the row's OWN agency, naming cause + winner;
//   • redelivery of the same acceptance is a no-op — zero new history rows,
//     zero new audits (offset-redelivery safe);
//   • nothing in any response, event, or audit carries PII.
//
//   Run (repo root), with the live Tier-1 stack up + DB bootstrapped:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/application-service/selfcheck/verify-auto-withdrawal-slice.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import type { ApplicationAcceptedEvent, ApplicationStatus, AuditEvent } from '@usrp/shared-types';
import {
  createApplicationService,
  loadApplicationConfig,
  officerTransitionRoutes,
  startApplicationAcceptedConsumer,
  ACCEPT_PATH,
} from '../src/index.js';

// ── In-test issuer key: set the verify public key BEFORE loading config ──
const AUTH_KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(AUTH_KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Deterministic fixtures (ad170000 — unique to this proof) ──────
// ONE citizen with applications everywhere: the RDF winner plus four
// siblings covering every withdrawal class and the terminal control.
const APPLICANT_W = 'ad170000-0000-4000-8000-000000000001';
const NID_HASH = 'ad17ad17'.repeat(8); // 64 hex
const RDF_CAMPAIGN = 'ad170000-0000-4000-8000-0000000000c1';
const RNP_CAMPAIGN = 'ad170000-0000-4000-8000-0000000000c2';
const RCS_CAMPAIGN = 'ad170000-0000-4000-8000-0000000000c3';
const RDF_OFFICER_ID = 'ad170000-0000-4000-8000-00000000ff01';

const RDF_WIN = 'ad170000-0000-4000-8000-00000000a001'; // FINAL_SHORTLIST → accepted
const RDF_SIB = 'ad170000-0000-4000-8000-00000000a002'; // SUBMITTED, same agency → WITHDRAWN
const RNP_SIB = 'ad170000-0000-4000-8000-00000000b001'; // SLOT_ASSIGNED, sibling agency → WITHDRAWN
const RCS_HOLD = 'ad170000-0000-4000-8000-00000000b002'; // ADJUDICATION_REVIEW hold (D6) → WITHDRAWN
const RNP_REJ = 'ad170000-0000-4000-8000-00000000b003'; // already REJECTED → untouched

const WITHDRAWN_SET: ReadonlyArray<readonly [string, 'rdf_ops' | 'rnp_ops' | 'rcs_ops', ApplicationStatus]> = [
  [RDF_SIB, 'rdf_ops', 'SUBMITTED'],
  [RNP_SIB, 'rnp_ops', 'SLOT_ASSIGNED'],
  [RCS_HOLD, 'rcs_ops', 'ADJUDICATION_REVIEW'],
];

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function mintOfficer(): string {
  const claims: AuthTokenClaims = {
    v: 1,
    iss: 'usrp',
    aud: 'usrp-services',
    sub: RDF_OFFICER_ID,
    kind: 'officer',
    agency: 'RDF',
    roles: [],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const schema of ['rdf_ops', 'rnp_ops', 'rcs_ops'] as const) {
      await tx`
        DELETE FROM ${tx(schema)}.application_status_history
        WHERE application_id IN (SELECT id FROM ${tx(schema)}.applications WHERE applicant_id = ${APPLICANT_W})`;
      await tx`DELETE FROM ${tx(schema)}.applications WHERE applicant_id = ${APPLICANT_W}`;
    }
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([RDF_CAMPAIGN, RNP_CAMPAIGN, RCS_CAMPAIGN])}`;
    // Deleting the identity row also clears the accept-lock stamped this run.
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_W}`;
  });
}

async function seed(): Promise<void> {
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status)
    VALUES (${APPLICANT_W}, ${NID_HASH}, 'x', 'x', 'x', 'x', 'MALE', 'WEB',
            'VERIFIED'::public_core.identity_verification_status)`;
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${RDF_CAMPAIGN}, 'Auto-withdrawal RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7),
      (${RNP_CAMPAIGN}, 'Auto-withdrawal RNP', 'RNP', 'REGISTRATION_OPEN', '["CADET_OFFICER"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7),
      (${RCS_CAMPAIGN}, 'Auto-withdrawal RCS', 'RCS', 'REGISTRATION_OPEN', '["GENERAL_ENLISTEE"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;

  await admin`
    INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES
      (${RDF_WIN}, 'RDF-98001', ${APPLICANT_W}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT',
       'FINAL_SHORTLIST'::rdf_ops.application_status),
      (${RDF_SIB}, 'RDF-98002', ${APPLICANT_W}, ${RDF_CAMPAIGN}, 'GENERAL_ENLISTMENT',
       'SUBMITTED'::rdf_ops.application_status)`;
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES
      (${RNP_SIB}, 'RNP-98001', ${APPLICANT_W}, ${RNP_CAMPAIGN}, 'CADET_OFFICER',
       'SLOT_ASSIGNED'::rnp_ops.application_status),
      (${RNP_REJ}, 'RNP-98002', ${APPLICANT_W}, ${RNP_CAMPAIGN}, 'CADET_OFFICER',
       'REJECTED'::rnp_ops.application_status)`;
  await admin`
    INSERT INTO rcs_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RCS_HOLD}, 'RCS-98001', ${APPLICANT_W}, ${RCS_CAMPAIGN}, 'GENERAL_ENLISTEE',
            'ADJUDICATION_REVIEW'::rcs_ops.application_status)`;
}

async function statusOf(schema: 'rdf_ops' | 'rnp_ops' | 'rcs_ops', id: string): Promise<string> {
  const rows = await admin<{ status: string }[]>`
    SELECT status::text AS status FROM ${admin(schema)}.applications WHERE id = ${id}`;
  return rows[0]?.status ?? '<missing>';
}

async function historyCount(schema: 'rdf_ops' | 'rnp_ops' | 'rcs_ops', id: string): Promise<number> {
  const rows = await admin<{ n: string }[]>`
    SELECT count(*)::text AS n FROM ${admin(schema)}.application_status_history WHERE application_id = ${id}`;
  return Number(rows[0]?.n ?? '0');
}

async function main(): Promise<void> {
  await cleanup();
  await seed();

  // ── Boot the REAL service; subscribe the withdrawal projection exactly as
  // main.ts does — the accept's publish fans out to it on the same bus. ──
  const config = loadApplicationConfig();
  const bus = new InMemoryEventBus();
  const service = createApplicationService(config, bus);
  await startApplicationAcceptedConsumer(bus, service.withdrawalProjector);
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });
  const server = await startHttpServer({
    serviceName: 'application-service-withdrawal-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: officerTransitionRoutes(service.officerTransitions, verify),
    handleSignals: false,
  });
  console.log(`\nService listening at ${server.url}`);

  try {
    console.log('\n── 1. REAL officer accept → 200 APPLIED + APPLICATION_ACCEPTED emitted ──');
    const res = await fetch(`${server.url}${ACCEPT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mintOfficer()}` },
      body: JSON.stringify({ applicationId: RDF_WIN }),
    });
    const text = await res.text();
    check('accept → 200 APPLIED', res.status === 200 && text.includes('APPLIED'), `got ${res.status} ${text}`);
    check('accepted row is ACCEPTED', (await statusOf('rdf_ops', RDF_WIN)) === 'ACCEPTED');

    const acceptedEvents = bus.published.filter(
      (e): e is ApplicationAcceptedEvent => e.eventType === 'APPLICATION_ACCEPTED',
    );
    check('exactly ONE APPLICATION_ACCEPTED emitted', acceptedEvents.length === 1, `got ${acceptedEvents.length}`);
    const accepted = acceptedEvents[0];
    check('event carries the applicant UUID', accepted?.applicantId === APPLICANT_W);
    check('event carries the accepted application + agency', accepted?.applicationId === RDF_WIN && accepted?.agency === 'RDF');
    check('event carries campaign + category', accepted?.campaignId === RDF_CAMPAIGN && accepted?.category === 'GENERAL_ENLISTMENT');

    console.log('\n── 2. All non-terminal siblings → WITHDRAWN, cross-agency (D6) ──');
    for (const [id, schema, from] of WITHDRAWN_SET) {
      check(`${schema} ${from} sibling → WITHDRAWN`, (await statusOf(schema, id)) === 'WITHDRAWN', await statusOf(schema, id));
    }

    console.log('\n── 3. Terminal rows untouched ──');
    check('already-REJECTED sibling stays REJECTED', (await statusOf('rnp_ops', RNP_REJ)) === 'REJECTED');
    check('accepted row stays ACCEPTED', (await statusOf('rdf_ops', RDF_WIN)) === 'ACCEPTED');
    check('REJECTED sibling gained NO history row', (await historyCount('rnp_ops', RNP_REJ)) === 0);

    console.log('\n── 4. History: one append per withdrawal, true prior status, SYSTEM author ──');
    for (const [id, schema, from] of WITHDRAWN_SET) {
      const rows = await admin<{ from_status: string; to_status: string; performed_by: string }[]>`
        SELECT from_status::text AS from_status, to_status::text AS to_status, performed_by
        FROM ${admin(schema)}.application_status_history WHERE application_id = ${id}`;
      check(
        `${schema} history: exactly one ${from} → WITHDRAWN row by SYSTEM`,
        rows.length === 1 && rows[0]?.from_status === from && rows[0]?.to_status === 'WITHDRAWN' && rows[0]?.performed_by === 'SYSTEM',
        JSON.stringify(rows),
      );
    }

    console.log('\n── 5. Audit: one APPLICATION_WITHDRAWN per row, own agency, cause named ──');
    const audits = bus.published.filter(
      (e): e is AuditEvent => e.eventType === 'AUDIT_ENTRY' && (e as AuditEvent).action === 'APPLICATION_WITHDRAWN',
    );
    check('exactly THREE withdrawal audits', audits.length === 3, `got ${audits.length}`);
    for (const [id, schema, from] of WITHDRAWN_SET) {
      const agency = schema === 'rdf_ops' ? 'RDF' : schema === 'rnp_ops' ? 'RNP' : 'RCS';
      const audit = audits.find((a) => a.entityId === id);
      check(
        `audit for ${agency} row: own agency, prior=${from}, cause + winner in metadata`,
        audit !== undefined &&
          audit.agency === agency &&
          audit.previousStatus === from &&
          audit.newStatus === 'WITHDRAWN' &&
          audit.performedBy === 'application-service' &&
          audit.metadata?.['cause'] === 'ACCEPTED_ELSEWHERE' &&
          audit.metadata?.['acceptedApplicationId'] === RDF_WIN &&
          audit.metadata?.['acceptedByAgency'] === 'RDF',
        JSON.stringify(audit ?? {}),
      );
    }
    check('NO event carries the national_id_hash', !JSON.stringify(bus.published).includes(NID_HASH));

    console.log('\n── 6. Redelivery is a no-op (offset-redelivery safety) ──');
    if (accepted) await bus.publish(accepted); // second delivery of the SAME acceptance
    const auditsAfter = bus.published.filter(
      (e) => e.eventType === 'AUDIT_ENTRY' && (e as AuditEvent).action === 'APPLICATION_WITHDRAWN',
    );
    check('no new withdrawal audits on redelivery', auditsAfter.length === 3, `got ${auditsAfter.length}`);
    let historyTotal = 0;
    for (const [id, schema] of WITHDRAWN_SET) historyTotal += await historyCount(schema, id);
    check('no new history rows on redelivery (still 3 total)', historyTotal === 3, `got ${historyTotal}`);
    check('REJECTED control still REJECTED after redelivery', (await statusOf('rnp_ops', RNP_REJ)) === 'REJECTED');
  } finally {
    await cleanup();
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('AUTO-WITHDRAWAL PROVEN (live) — one acceptance retires every other application, cross-agency ✓');
  else console.error(`${failures} ASSERTION(S) FAILED ✗`);
}

main()
  .then(async () => {
    await Promise.all([sql.end(), admin.end()]);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err: unknown) => {
    console.error('\nSELF-CHECK CRASHED:', err);
    await Promise.all([sql.end(), admin.end()]);
    process.exit(1);
  });
