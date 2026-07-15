// ══════════════════════════════════════════════════════════════════
// application-service — Amber lane routing + adjudication self-check
//
// Proves the amber lane's back half (ADR-011) against live PG + real
// sockets, with the forensics projector, the officer endpoints, and REAL
// scheduling-service wired over one InMemoryEventBus:
//
//   Routing projection (system):
//     • AMBER verdict pre-slot → DOCUMENT_REVIEW_AMBER (hold);
//     • redelivered AMBER → NO_CHANGE (idempotent);
//     • RED pre-slot → REJECTED; RED post-slot → ADJUDICATION_REVIEW;
//     • GREEN → NO_CHANGE (status never moves);
//     • cross-agency claim → NOT_FOUND; terminal row → NOT_APPLICABLE.
//   Officer queue (GET /v1/applications/amber-queue):
//     • amber app listed w/ document signals; adjudication hold listed;
//     • other-agency rows invisible; 401/403.
//   Officer adjudication (POST /v1/applications/adjudicate):
//     • CLEAR on all-pass evidence → DOCUMENT_REVIEW_GREEN, emits
//       application.cleared → REAL scheduling assigns → SLOT_ASSIGNED
//       (amber-cleared reconverges on the green slot lane, D4, e2e);
//     • CLEAR with pending evidence → the furthest vetting stage (no
//       premature green); document rows stamped by the officer;
//     • REJECT → REJECTED + stamps; late lifecycle hard-fail →
//       ADJUDICATION_REVIEW → CLEAR restores the pre-flag stage from
//       history; 409 NOT_APPLICABLE / 404 cross-agency / 401 / 403;
//     • append-only history rows + ONE AUDIT_ENTRY per genuine transition.
//
//   bash scripts/run-selfchecks.sh   (or standalone with the env below)
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import {
  createApplicationService,
  loadApplicationConfig,
  startForensicsResultConsumer,
  amberQueueRoute,
  listApplicationsRoute,
  officerTransitionRoutes,
  AMBER_QUEUE_PATH,
  ADJUDICATE_PATH,
} from '../src/index.js';
import type { DocumentForensicsCompletedEvent, ForensicsFlags } from '@usrp/shared-types';
import {
  createSchedulingService,
  loadSchedulingConfig,
  startApplicationClearedConsumer,
} from '@usrp/scheduling-service';

// ── Environment ───────────────────────────────────────────────────

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });
const ENCRYPTION_KEY = process.env['PII_ENCRYPTION_KEY'] ?? 'dev_pii_encryption_key_min_32_chars_ok!!';

const AUTH_KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(AUTH_KEYS.publicKeyPem, 'utf8').toString('base64');
// scheduling config needs a QR signing key to load.
const QR_KEYS = generateDeviceKeyPair();
process.env['QR_SIGNING_PRIVATE_KEY_B64'] ??= Buffer.from(QR_KEYS.privateKeyPem, 'utf8').toString('base64');
process.env['QR_SIGNING_KEY_ID'] ??= 'amber-selfcheck-key-1';

const APPLICANT = '6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e';
const RNP_APPLICANT = '6d6d6d6d-6d6d-4d6d-8d6d-6d6d6d6d6d6d';
const CAMPAIGN = '6ec11111-1111-4111-8111-111111111111';
const RNP_CAMPAIGN = '6ec22222-2222-4222-8222-222222222222';
const VENUE_DISTRICT = 'GASABO';

// One app per scenario (all RDF except the cross-agency probe).
const APP_AMBER_CLEAR = '6ea11111-1111-4111-8111-111111111111'; // all-pass evidence → CLEAR → GREEN → SLOT_ASSIGNED
const APP_AMBER_PENDING = '6ea22222-2222-4222-8222-222222222222'; // pending criminal → CLEAR → vetting stage
const APP_AMBER_REJECT = '6ea33333-3333-4333-8333-333333333333'; // REJECT path + document stamps
const APP_RED_EARLY = '6ea44444-4444-4444-8444-444444444444'; // RED pre-slot → REJECTED
const APP_RED_LATE = '6ea55555-5555-4555-8555-555555555555'; // RED post-slot → ADJUDICATION_REVIEW → CLEAR restores
const APP_GREEN = '6ea66666-6666-4666-8666-666666666666'; // GREEN verdict → no move
const RNP_APP = '6ea77777-7777-4777-8777-777777777777'; // cross-agency probe

const OFFICER_ID = '6e011111-1111-4111-8111-111111111111';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function mint(kind: 'system' | 'officer', agency: 'RDF' | 'RNP' = 'RDF'): string {
  const base = {
    v: 1 as const, iss: 'usrp', aud: 'usrp-services',
    sub: kind === 'officer' ? OFFICER_ID : 'selfcheck-system',
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer' ? { ...base, kind, agency, roles: [] } : { ...base, kind };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}
const OFFICER_TOKEN = mint('officer');
const RNP_OFFICER_TOKEN = mint('officer', 'RNP');
const SYSTEM_TOKEN = mint('system');

const CLEAN_FLAGS: ForensicsFlags = {
  elaAnomalyDetected: null, fontMismatchDetected: null, stampCloneDetected: null,
  ganGeneratedDetected: null, c2paManifestValid: null,
  virusScanClean: true, metadataStripped: true, overallScore: 65,
};

// ── Seed / teardown ───────────────────────────────────────────────

const ALL_RDF_APPS = [
  APP_AMBER_CLEAR, APP_AMBER_PENDING, APP_AMBER_REJECT,
  APP_RED_EARLY, APP_RED_LATE, APP_GREEN,
];

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.document_records WHERE application_id IN ${tx(ALL_RDF_APPS)}`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id IN ${tx(ALL_RDF_APPS)}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id IN ${tx(ALL_RDF_APPS)}`;
    await tx`DELETE FROM rnp_ops.application_status_history WHERE application_id = ${RNP_APP}`;
    await tx`DELETE FROM rnp_ops.applications WHERE id = ${RNP_APP}`;
    await tx`DELETE FROM public_core.campaign_venue_assignments WHERE campaign_id = ${CAMPAIGN}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([CAMPAIGN, RNP_CAMPAIGN])}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx([APPLICANT, RNP_APPLICANT])}`;
  });
}

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.encryption_key', ${ENCRYPTION_KEY}, true)`;
    for (const [id] of [[APPLICANT], [RNP_APPLICANT]] as const) {
      await tx`
        INSERT INTO public_core.applicant_identities
          (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
           encrypted_home_district, encrypted_home_province, gender,
           registration_channel, identity_status)
        VALUES (
          ${id}, ${randomUUID().replace(/-/g, '')},
          pgp_sym_encrypt('Amber Fixture', current_setting('app.encryption_key')),
          pgp_sym_encrypt('2003-03-15',    current_setting('app.encryption_key')),
          pgp_sym_encrypt(${VENUE_DISTRICT}, current_setting('app.encryption_key')),
          pgp_sym_encrypt('KIGALI_CITY',   current_setting('app.encryption_key')),
          'MALE'::public_core.gender, 'WEB'::public_core.application_channel,
          'VERIFIED'::public_core.identity_verification_status)`;
    }
  });
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${CAMPAIGN}, 'Amber slice RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days', '2026-11-01', '2026-11-15', 7),
      (${RNP_CAMPAIGN}, 'Amber slice RNP', 'RNP', 'REGISTRATION_OPEN', '["CADET_OFFICER"]',
       now() - interval '1 day', now() + interval '30 days', '2026-11-01', '2026-11-15', 7)`;
  await admin`
    INSERT INTO public_core.campaign_venue_assignments
      (campaign_id, district, province, venue_name, exam_date, reporting_time_hour)
    VALUES (${CAMPAIGN}, ${VENUE_DISTRICT}, 'KIGALI_CITY', 'Amasimbi Stadium', '2026-11-05', 8)`;

  // Seed scenario rows. Vetting evidence: the CLEAR path carries all-pass
  // evidence; the PENDING path leaves criminal at PENDING; the rest default.
  const rows: ReadonlyArray<[string, string, string, boolean]> = [
    [APP_AMBER_CLEAR, 'RDF-98001', 'CRIMINAL_CLEARANCE', true],
    [APP_AMBER_PENDING, 'RDF-98002', 'ACADEMIC_VETTING', false],
    [APP_AMBER_REJECT, 'RDF-98003', 'CRIMINAL_CLEARANCE', true],
    [APP_RED_EARLY, 'RDF-98004', 'SUBMITTED', false],
    [APP_RED_LATE, 'RDF-98005', 'SLOT_ASSIGNED', true],
    [APP_GREEN, 'RDF-98006', 'SUBMITTED', false],
  ];
  for (const [id, code, status, allPass] of rows) {
    await admin`
      INSERT INTO rdf_ops.applications
        (id, processing_code, applicant_id, campaign_id, category, status,
         age_eligibility_status, academic_status, criminal_clearance_status)
      VALUES (${id}, ${code}, ${APPLICANT}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT',
              ${status}::rdf_ops.application_status,
              ${allPass ? 'ELIGIBLE' : 'ELIGIBLE'}::rdf_ops.age_eligibility_status,
              ${allPass ? 'ELIGIBLE' : 'ELIGIBLE'}::rdf_ops.academic_eligibility_status,
              ${allPass ? 'CLEARED' : 'PENDING'}::rdf_ops.criminal_clearance_status)`;
  }
  await admin`
    INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RNP_APP}, 'RNP-98001', ${RNP_APPLICANT}, ${RNP_CAMPAIGN}, 'CADET_OFFICER',
            'SUBMITTED'::rnp_ops.application_status)`;
}

async function statusOf(id: string, schema: 'rdf_ops' | 'rnp_ops' = 'rdf_ops'): Promise<string> {
  const rows = await admin<{ status: string }[]>`
    SELECT status FROM ${admin(schema)}.applications WHERE id = ${id}`;
  return rows[0]?.status ?? '(absent)';
}

/** Seed a document_records row (the forensics service's output half). */
async function seedDocument(appId: string, lane: 'AMBER' | 'RED' | 'GREEN', key: string): Promise<string> {
  const rows = await admin<{ id: string }[]>`
    INSERT INTO rdf_ops.document_records
      (application_id, document_type, minio_object_key, minio_object_bucket,
       virus_scan_status, forensics_score, forensics_lane, forensics_flags, forensics_completed_at)
    VALUES (${appId}, 'OLEVEL_CERTIFICATE'::rdf_ops.document_type, ${key}, 'usrp-documents',
            'CLEAN', ${lane === 'GREEN' ? 100 : lane === 'AMBER' ? 65 : 20},
            ${lane}::rdf_ops.document_lane, ${JSON.stringify(CLEAN_FLAGS)}::jsonb, now())
    RETURNING id`;
  const id = rows[0]?.id;
  if (!id) throw new Error('document seed failed');
  return id;
}

function forensicsEvent(appId: string, lane: 'AMBER' | 'RED' | 'GREEN', documentId: string): DocumentForensicsCompletedEvent {
  return {
    eventId: randomUUID(), eventVersion: '1.0', occurredAt: new Date().toISOString(),
    correlationId: randomUUID(), causationId: randomUUID(),
    eventType: 'DOCUMENT_FORENSICS_COMPLETED',
    applicationId: appId, agency: 'RDF', documentId,
    documentType: 'OLEVEL_CERTIFICATE', lane,
    forensicsScore: lane === 'GREEN' ? 100 : lane === 'AMBER' ? 65 : 20,
    flags: CLEAN_FLAGS,
  };
}

interface HttpReply { readonly status: number; readonly body: Record<string, unknown>; }
async function call(base: string, method: string, path: string, token?: string, body?: unknown): Promise<HttpReply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, body: parsed };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until the app reaches a status (the cleared→slot chain is async). */
async function awaitStatus(id: string, want: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await statusOf(id);
    if (last === want) return last;
    await sleep(150);
  }
  return last;
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n══ application-service — amber routing + adjudication self-check ══');
  await cleanup();
  await seed();

  // One shared bus: forensics projector + officer emit + REAL scheduling +
  // slot projector — the full reconvergence loop in-process.
  const bus = new InMemoryEventBus();
  const appService = createApplicationService(loadApplicationConfig(), bus);
  await startForensicsResultConsumer(bus, appService.forensicsProjector);
  const scheduling = createSchedulingService(loadSchedulingConfig(), bus);
  await startApplicationClearedConsumer(bus, scheduling.assignSlot);
  const { startSlotAssignedConsumer } = await import('../src/index.js');
  await startSlotAssignedConsumer(bus, appService.slotProjector);

  const verify = makeAuthVerifier({
    publicKeyPem: AUTH_KEYS.publicKeyPem, issuer: 'usrp', audience: 'usrp-services',
  });
  const server = await startHttpServer({
    serviceName: 'amber-adjudication-selfcheck',
    port: 0,
    routes: [
      listApplicationsRoute(appService.list, verify),
      amberQueueRoute(appService.list, verify),
      ...officerTransitionRoutes(appService.officerTransitions, verify),
    ],
  });
  const base = server.url;

  try {
    console.log('\n── 1. Routing: AMBER verdict holds the application ──');
    {
      const doc = await seedDocument(APP_AMBER_CLEAR, 'AMBER', 'amber-clear.jpg');
      await bus.publish(forensicsEvent(APP_AMBER_CLEAR, 'AMBER', doc));
      check('CRIMINAL_CLEARANCE + AMBER → DOCUMENT_REVIEW_AMBER',
        (await statusOf(APP_AMBER_CLEAR)) === 'DOCUMENT_REVIEW_AMBER');

      // Redelivery: same event again → still AMBER, no extra history row.
      const historyBefore = await admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM rdf_ops.application_status_history
        WHERE application_id = ${APP_AMBER_CLEAR}`;
      await bus.publish(forensicsEvent(APP_AMBER_CLEAR, 'AMBER', doc));
      const historyAfter = await admin<{ n: number }[]>`
        SELECT count(*)::int AS n FROM rdf_ops.application_status_history
        WHERE application_id = ${APP_AMBER_CLEAR}`;
      check('redelivered AMBER → NO_CHANGE (no new history)',
        historyBefore[0]?.n === historyAfter[0]?.n);

      const doc2 = await seedDocument(APP_AMBER_PENDING, 'AMBER', 'amber-pending.jpg');
      await bus.publish(forensicsEvent(APP_AMBER_PENDING, 'AMBER', doc2));
      check('ACADEMIC_VETTING + AMBER → DOCUMENT_REVIEW_AMBER (pending evidence)',
        (await statusOf(APP_AMBER_PENDING)) === 'DOCUMENT_REVIEW_AMBER');
      const doc3 = await seedDocument(APP_AMBER_REJECT, 'AMBER', 'amber-reject.jpg');
      await bus.publish(forensicsEvent(APP_AMBER_REJECT, 'AMBER', doc3));
    }

    console.log('\n── 2. Routing: RED early rejects, RED late adjudicates, GREEN no-ops ──');
    {
      const docE = await seedDocument(APP_RED_EARLY, 'RED', 'red-early.jpg');
      await bus.publish(forensicsEvent(APP_RED_EARLY, 'RED', docE));
      check('SUBMITTED + RED → REJECTED (pre-slot autonomous)',
        (await statusOf(APP_RED_EARLY)) === 'REJECTED');

      const docL = await seedDocument(APP_RED_LATE, 'RED', 'red-late.jpg');
      await bus.publish(forensicsEvent(APP_RED_LATE, 'RED', docL));
      check('SLOT_ASSIGNED + RED → ADJUDICATION_REVIEW (late → human)',
        (await statusOf(APP_RED_LATE)) === 'ADJUDICATION_REVIEW');

      const docG = await seedDocument(APP_GREEN, 'GREEN', 'green.jpg');
      await bus.publish(forensicsEvent(APP_GREEN, 'GREEN', docG));
      check('SUBMITTED + GREEN → status unmoved', (await statusOf(APP_GREEN)) === 'SUBMITTED');

      // Terminal guard: RED on the already-REJECTED row is a no-op.
      await bus.publish(forensicsEvent(APP_RED_EARLY, 'RED', docE));
      check('RED on terminal row → stays REJECTED', (await statusOf(APP_RED_EARLY)) === 'REJECTED');
    }

    console.log('\n── 3. Officer amber queue (agency-scoped, non-PII) ──');
    {
      const q = await call(base, 'GET', AMBER_QUEUE_PATH, OFFICER_TOKEN);
      check('200 OK', q.status === 200);
      const queue = (q.body['queue'] ?? []) as Record<string, unknown>[];
      const codes = queue.map((e) => e['processingCode']);
      check('3 amber + 1 adjudication hold listed', queue.length === 4, `got ${queue.length}: ${codes.join(',')}`);
      const amberEntry = queue.find((e) => e['processingCode'] === 'RDF-98001');
      check('amber entry carries document signals',
        amberEntry?.['documentType'] === 'OLEVEL_CERTIFICATE' && amberEntry?.['forensicsScore'] === 65);
      const lateEntry = queue.find((e) => e['processingCode'] === 'RDF-98005');
      check('adjudication hold listed w/o document fields',
        lateEntry !== undefined && lateEntry['status'] === 'ADJUDICATION_REVIEW' && lateEntry['documentType'] === null);
      check('no PII fields in queue', !JSON.stringify(queue).toLowerCase().includes('name'));

      const rnpQ = await call(base, 'GET', AMBER_QUEUE_PATH, RNP_OFFICER_TOKEN);
      check('RNP officer sees an EMPTY queue (agency isolation)',
        rnpQ.status === 200 && ((rnpQ.body['queue'] ?? []) as unknown[]).length === 0);
      check('401 unauthenticated', (await call(base, 'GET', AMBER_QUEUE_PATH)).status === 401);
      check('403 system token', (await call(base, 'GET', AMBER_QUEUE_PATH, SYSTEM_TOKEN)).status === 403);
    }

    console.log('\n── 4. CLEAR on all-pass evidence → GREEN → application.cleared → SLOT_ASSIGNED (e2e) ──');
    {
      const r = await call(base, 'POST', ADJUDICATE_PATH, OFFICER_TOKEN, {
        applicationId: APP_AMBER_CLEAR, decision: 'CLEAR',
      });
      check('200 APPLIED AMBER → GREEN', r.status === 200 && r.body['toStatus'] === 'DOCUMENT_REVIEW_GREEN',
        JSON.stringify(r.body));
      const finalStatus = await awaitStatus(APP_AMBER_CLEAR, 'SLOT_ASSIGNED');
      check('amber-cleared app reconverged to SLOT_ASSIGNED via REAL scheduling',
        finalStatus === 'SLOT_ASSIGNED', `got ${finalStatus}`);
      const stamped = await admin<{ human_reviewed_by_id: string | null; human_review_decision: string | null }[]>`
        SELECT human_reviewed_by_id, human_review_decision FROM rdf_ops.document_records
        WHERE application_id = ${APP_AMBER_CLEAR}`;
      check('document stamped by officer (UUID) with CLEAR',
        stamped[0]?.human_reviewed_by_id === OFFICER_ID && stamped[0]?.human_review_decision === 'CLEAR');
      const slotRow = await admin<{ qr_invitation_code: string | null }[]>`
        SELECT qr_invitation_code FROM rdf_ops.applications WHERE id = ${APP_AMBER_CLEAR}`;
      check('QR invitation minted on reconvergence', typeof slotRow[0]?.qr_invitation_code === 'string');
    }

    console.log('\n── 5. CLEAR with pending evidence → furthest vetting stage, never green ──');
    {
      const r = await call(base, 'POST', ADJUDICATE_PATH, OFFICER_TOKEN, {
        applicationId: APP_AMBER_PENDING, decision: 'CLEAR',
      });
      check('200 APPLIED', r.status === 200 && r.body['status'] === 'APPLIED', JSON.stringify(r.body));
      const status = await statusOf(APP_AMBER_PENDING);
      check('pending criminal ⇒ lands at ACADEMIC_VETTING (not GREEN)',
        status === 'ACADEMIC_VETTING', `got ${status}`);
    }

    console.log('\n── 6. REJECT → REJECTED + stamps; guards ──');
    {
      const r = await call(base, 'POST', ADJUDICATE_PATH, OFFICER_TOKEN, {
        applicationId: APP_AMBER_REJECT, decision: 'REJECT', notes: 'Certificate inconsistent with registry',
      });
      check('200 APPLIED AMBER → REJECTED', r.status === 200 && r.body['toStatus'] === 'REJECTED');
      const stamped = await admin<{ human_review_decision: string | null }[]>`
        SELECT human_review_decision FROM rdf_ops.document_records WHERE application_id = ${APP_AMBER_REJECT}`;
      check('document stamped REJECT', stamped[0]?.human_review_decision === 'REJECT');

      const again = await call(base, 'POST', ADJUDICATE_PATH, OFFICER_TOKEN, {
        applicationId: APP_AMBER_REJECT, decision: 'REJECT',
      });
      check('re-adjudicating a terminal row → 409 NOT_APPLICABLE', again.status === 409);
      const wrongAgency = await call(base, 'POST', ADJUDICATE_PATH, RNP_OFFICER_TOKEN, {
        applicationId: APP_AMBER_PENDING, decision: 'REJECT',
      });
      check('cross-agency adjudicate → 404', wrongAgency.status === 404);
      check('401 unauthenticated', (await call(base, 'POST', ADJUDICATE_PATH, undefined, {
        applicationId: APP_AMBER_PENDING, decision: 'REJECT' })).status === 401);
      check('403 system token', (await call(base, 'POST', ADJUDICATE_PATH, SYSTEM_TOKEN, {
        applicationId: APP_AMBER_PENDING, decision: 'REJECT' })).status === 403);
      const badDecision = await call(base, 'POST', ADJUDICATE_PATH, OFFICER_TOKEN, {
        applicationId: APP_AMBER_PENDING, decision: 'MAYBE',
      });
      check('invalid decision → 400', badDecision.status === 400);
    }

    console.log('\n── 7. Late hold: CLEAR restores the pre-flag stage from history ──');
    {
      // APP_RED_LATE entered ADJUDICATION_REVIEW from SLOT_ASSIGNED in §2.
      const r = await call(base, 'POST', ADJUDICATE_PATH, OFFICER_TOKEN, {
        applicationId: APP_RED_LATE, decision: 'CLEAR', notes: 'False positive — registry mismatch resolved',
      });
      check('200 APPLIED ADJUDICATION_REVIEW → SLOT_ASSIGNED (restored)',
        r.status === 200 && r.body['toStatus'] === 'SLOT_ASSIGNED', JSON.stringify(r.body));
      check('row restored', (await statusOf(APP_RED_LATE)) === 'SLOT_ASSIGNED');
      // Not a document decision — the RED document row is NOT stamped.
      const doc = await admin<{ human_reviewed_by_id: string | null }[]>`
        SELECT human_reviewed_by_id FROM rdf_ops.document_records WHERE application_id = ${APP_RED_LATE}`;
      check('late-hold clear stamps no document', doc[0]?.human_reviewed_by_id === null);
    }

    console.log('\n── 8. Trail: append-only history + audit entries ──');
    {
      const history = await admin<{ to_status: string; performed_by: string }[]>`
        SELECT to_status, performed_by FROM rdf_ops.application_status_history
        WHERE application_id = ${APP_AMBER_CLEAR} ORDER BY performed_at`;
      const chain = history.map((h) => h.to_status).join('→');
      check('history: AMBER → GREEN → SLOT_ASSIGNED all recorded',
        chain.includes('DOCUMENT_REVIEW_AMBER') && chain.includes('DOCUMENT_REVIEW_GREEN') && chain.includes('SLOT_ASSIGNED'),
        chain);
      check('adjudication history row attributed to the officer',
        history.some((h) => h.performed_by === OFFICER_ID));
      const audits = bus.published.filter((e) => e.eventType === 'AUDIT_ENTRY');
      check('audit entries emitted for routing + adjudication + slot',
        audits.length >= 6, `got ${audits.length}`);
      const adjudicationAudits = audits.filter(
        (e) => 'metadata' in e && (e.metadata as Record<string, unknown>)?.['stage'] === 'ADJUDICATION');
      check('one ADJUDICATION audit per genuine decision (4: clear, clear, reject, late-clear)',
        adjudicationAudits.length === 4, `got ${adjudicationAudits.length}`);
    }
  } finally {
    await server.stop();
    await cleanup();
    await admin.end({ timeout: 5 });
    const { sql } = await import('@usrp/shared-database');
    await sql.end({ timeout: 5 });
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) {
    console.log('AMBER LANE PROVEN — routed, queued, adjudicated, reconverged ✓');
    process.exit(0);
  }
  console.error(`${failures} ASSERTION(S) FAILED ✗`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('SELF-CHECK CRASHED:', err);
  process.exit(1);
});
