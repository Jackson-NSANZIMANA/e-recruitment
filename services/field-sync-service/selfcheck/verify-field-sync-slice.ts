// ══════════════════════════════════════════════════════════════════
// field-sync-service — Live offline physical-test capture & sync self-check
//
// Proves the whole slice end-to-end against LIVE Postgres, over a real socket,
// with a real InMemoryEventBus wiring field-sync → application-service (ADR-010):
//   • pure vector-clock / merge maths (compareClocks, decideMerge);
//   • enroll a device (officer-auth) → sign a record → sync → row stored +
//     FIELD_SCORE_CAPTURED emitted → application-service advances the
//     application PHYSICAL_TEST_SCHEDULED → PHYSICAL_TEST_COMPLETE, stamping the
//     score row (biometric precondition satisfied);
//   • out-of-order + duplicate resync converge (idempotent — supersede / stale /
//     dedup);
//   • concurrent captures from two devices → conflict flagged + application HELD
//     (engine-enforced, no silent official score) → resolve endpoint clears it
//     and the application finally advances;
//   • tamper (bad signature), unenrolled device, revoked device, cross-agency
//     device, and wrong-agency application all REJECTED / guarded;
//   • biometric-precondition enforced (no completion without a check-in pass);
//   • auth: unauthenticated → 401, system token → 403 (officer-only routes).
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/field-sync-service/selfcheck/verify-field-sync-slice.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import {
  generateDeviceKeyPair,
  signFieldScoreRecord,
  type SignableFieldPayload,
} from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import type { FieldScoreRecord, PhysicalTestMetrics } from '@usrp/shared-types';
import {
  createFieldSyncService,
  enrollDeviceRoute,
  syncScoresRoute,
  resolveConflictRoute,
  ENROLL_DEVICE_PATH,
  SYNC_SCORES_PATH,
  RESOLVE_CONFLICT_PATH,
  compareClocks,
  decideMerge,
  loadFieldSyncConfig,
} from '../src/index.js';
import {
  createApplicationService,
  loadApplicationConfig,
  startFieldScoreCapturedConsumer,
} from '@usrp/application-service';

// ── Deterministic auth + DB env (mirrors the other service selfchecks) ──
const AUTH_KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(AUTH_KEYS.publicKeyPem, 'utf8').toString('base64');
process.env['JWT_ISSUER'] ??= 'usrp';
process.env['JWT_AUDIENCE'] ??= 'usrp-services';
process.env['DATABASE_URL'] ??= 'postgresql://usrp_app:app_pw@localhost:5432/usrp_db';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Fixture ids ────────────────────────────────────────────────────
const APPLICANT_BIO = '5f000000-0000-4000-8000-000000000001';   // has biometric_verified_at
const APPLICANT_NOBIO = '5f000000-0000-4000-8000-000000000002'; // no biometric
const CAMPAIGN_ID = '5f000000-0000-4000-8000-0000000000c0';
const APP_ACCEPT = '5f000000-0000-4000-8000-00000000a001';   // happy path → COMPLETE
const APP_ORDER = '5f000000-0000-4000-8000-00000000a002';    // out-of-order / stale / dup
const APP_CONFLICT = '5f000000-0000-4000-8000-00000000a003'; // concurrent → held → resolve
const APP_NOBIO = '5f000000-0000-4000-8000-00000000a004';    // biometric precondition
const APP_IDS = [APP_ACCEPT, APP_ORDER, APP_CONFLICT, APP_NOBIO];
const APPLICANT_IDS = [APPLICANT_BIO, APPLICANT_NOBIO];

const DEV_A = 'DEV-RDF-A';
const DEV_B = 'DEV-RDF-B';
const DEV_UNENROLLED = 'DEV-RDF-GHOST';
const DEV_REVOKED = 'DEV-RDF-REVOKED';
const DEVICE_IDS = [DEV_A, DEV_B, DEV_UNENROLLED, DEV_REVOKED];
const OFFICER_ID = '5f000000-0000-4000-8000-00000000ff01';

const keysA = generateDeviceKeyPair();
const keysB = generateDeviceKeyPair();
const keysRevoked = generateDeviceKeyPair();

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const METRICS: PhysicalTestMetrics = {
  heightCm: 178,
  weightKg: 72,
  run3kmTimeSeconds: 720,
  chestCm: 96,
  medicalFitnessStatus: 'FIT',
};

function makeRecord(
  applicationId: string,
  privateKeyPem: string,
  deviceId: string,
  vectorClock: Record<string, number>,
  metrics: PhysicalTestMetrics = METRICS,
): FieldScoreRecord {
  const payload: SignableFieldPayload = {
    applicationId,
    qrInvitationCode: `TICKET-${applicationId.slice(-4)}`,
    metrics,
    capturedAt: '2026-07-11T09:00:00.000Z',
    deviceId,
    capturingOfficerId: OFFICER_ID,
    vectorClock,
  };
  const sig = signFieldScoreRecord(privateKeyPem, payload);
  return { ...payload, deviceSignature: sig.deviceSignature, signedPayloadHash: sig.signedPayloadHash };
}

function token(kind: 'officer' | 'system', agency: 'RDF' | 'RNP' = 'RDF'): string {
  const base = {
    v: 1 as const, iss: 'usrp', aud: 'usrp-services', sub: OFFICER_ID,
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer' ? { ...base, kind, agency, roles: [] } : { ...base, kind };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}

async function cleanup(): Promise<void> {
  // History + applications are immutable/FK-guarded; the replica escape hatch
  // (superuser) disables the immutability + FK triggers for this teardown tx only.
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id = ANY(${APP_IDS}::uuid[])`;
    await tx`DELETE FROM rdf_ops.physical_test_scores WHERE application_id = ANY(${APP_IDS}::uuid[])`;
    await tx`DELETE FROM rdf_ops.applications WHERE id = ANY(${APP_IDS}::uuid[])`;
  });
  await admin`DELETE FROM public_core.field_devices WHERE device_id = ANY(${DEVICE_IDS})`;
  await admin`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN_ID}`;
  await admin`DELETE FROM public_core.applicant_identities WHERE id = ANY(${APPLICANT_IDS}::uuid[])`;
}

async function seed(): Promise<void> {
  await cleanup();

  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender, registration_channel,
       identity_status, biometric_verified_at)
    VALUES
      (${APPLICANT_BIO}, ${'a1'.repeat(32)}, 'x','x','x','x','MALE','WEB',
       'VERIFIED'::public_core.identity_verification_status, now()),
      (${APPLICANT_NOBIO}, ${'a2'.repeat(32)}, 'x','x','x','x','MALE','WEB',
       'VERIFIED'::public_core.identity_verification_status, NULL)`;

  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, target_categories, registration_opens_at,
       registration_closes_at, examination_start_date, examination_end_date,
       examination_reporting_hour, status)
    VALUES (${CAMPAIGN_ID}, 'RDF-FIELDSYNC-TEST', 'RDF', '["GENERAL_ENLISTMENT"]',
       now() - interval '10 days', now() + interval '10 days', '2026-08-01', '2026-08-05', 8,
       'REGISTRATION_OPEN'::public_core.campaign_status)`;

  // Four applications parked at PHYSICAL_TEST_SCHEDULED (the stage a score completes).
  const seedApp = (id: string, applicant: string, code: string) => admin`
    INSERT INTO rdf_ops.applications
      (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${id}, ${code}, ${applicant}, ${CAMPAIGN_ID},
       'GENERAL_ENLISTMENT'::rdf_ops.application_category,
       'PHYSICAL_TEST_SCHEDULED'::rdf_ops.application_status)`;
  await seedApp(APP_ACCEPT, APPLICANT_BIO, 'RDF-90001');
  await seedApp(APP_ORDER, APPLICANT_BIO, 'RDF-90002');
  await seedApp(APP_CONFLICT, APPLICANT_BIO, 'RDF-90003');
  await seedApp(APP_NOBIO, APPLICANT_NOBIO, 'RDF-90004');

  // A pre-revoked device (enrolled directly, revoked) to prove revocation-aware verify.
  await admin`
    INSERT INTO public_core.field_devices (device_id, public_key_pem, agency, enrolled_by, revoked_at)
    VALUES (${DEV_REVOKED}, ${keysRevoked.publicKeyPem}, 'RDF', ${OFFICER_ID}, now())`;
}

async function appStatus(id: string): Promise<string | null> {
  const rows = await admin<{ status: string }[]>`SELECT status FROM rdf_ops.applications WHERE id = ${id}`;
  return rows[0]?.status ?? null;
}
async function appScoreId(id: string): Promise<string | null> {
  const rows = await admin<{ sid: string | null }[]>`SELECT physical_test_score_id AS sid FROM rdf_ops.applications WHERE id = ${id}`;
  return rows[0]?.sid ?? null;
}

async function main(): Promise<void> {
  // ── 0. Pure domain maths — no infra ──────────────────────────────
  console.log('\n── 0. Vector-clock + merge maths (pure) ──');
  check('dominates', compareClocks({ a: 2 }, { a: 1 }) === 'DOMINATES');
  check('dominated', compareClocks({ a: 1 }, { a: 2 }) === 'DOMINATED');
  check('equal', compareClocks({ a: 1, b: 1 }, { a: 1, b: 1 }) === 'EQUAL');
  check('concurrent', compareClocks({ a: 1 }, { b: 1 }) === 'CONCURRENT');
  check('decideMerge ACCEPT on empty', decideMerge({ vectorClock: { a: 1 }, signedPayloadHash: 'h1' }, []).kind === 'ACCEPT');
  check(
    'decideMerge DUPLICATE on same hash',
    decideMerge({ vectorClock: { a: 2 }, signedPayloadHash: 'h1' }, [{ vectorClock: { a: 1 }, signedPayloadHash: 'h1' }]).kind === 'DUPLICATE',
  );
  check(
    'decideMerge SUPERSEDE when dominating',
    decideMerge({ vectorClock: { a: 2 }, signedPayloadHash: 'h2' }, [{ vectorClock: { a: 1 }, signedPayloadHash: 'h1' }]).kind === 'SUPERSEDE',
  );
  check(
    'decideMerge STALE when dominated',
    decideMerge({ vectorClock: { a: 1 }, signedPayloadHash: 'h2' }, [{ vectorClock: { a: 2 }, signedPayloadHash: 'h1' }]).kind === 'STALE',
  );
  check(
    'decideMerge CONFLICT when concurrent',
    decideMerge({ vectorClock: { b: 1 }, signedPayloadHash: 'h2' }, [{ vectorClock: { a: 1 }, signedPayloadHash: 'h1' }]).kind === 'CONFLICT',
  );

  await seed();

  const busMain = new InMemoryEventBus();
  const busQuiet = new InMemoryEventBus();
  const verify = makeAuthVerifier({ publicKeyPem: AUTH_KEYS.publicKeyPem, issuer: 'usrp', audience: 'usrp-services' });

  // field-sync bound to busMain (drives the HTTP endpoints + happy path);
  // a quiet-bus instance for the conflict app so we control when advances fire.
  const fsConfig = loadFieldSyncConfig();
  const fsMain = createFieldSyncService(fsConfig, busMain);
  const fsQuiet = createFieldSyncService(fsConfig, busQuiet);

  // application-service consumer on busMain — the real projection wiring.
  const appService = createApplicationService(loadApplicationConfig(), busMain);
  await startFieldScoreCapturedConsumer(busMain, appService.physicalTestProjector);

  const server = await startHttpServer({
    serviceName: 'field-sync-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [
      enrollDeviceRoute(fsMain.enrollDevice, verify),
      syncScoresRoute(fsMain.syncFieldScores, verify),
      resolveConflictRoute(fsMain.resolveConflict, verify),
    ],
    handleSignals: false,
  });
  const base = server.url;

  async function post(path: string, body: unknown, auth?: string) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, text, json };
  }
  async function syncOne(rec: FieldScoreRecord, auth = token('officer', 'RDF')) {
    const r = await post(SYNC_SCORES_PATH, { records: [rec] }, auth);
    const results = asRecord(r.json)['results'];
    const first = Array.isArray(results) ? asRecord(results[0]) : {};
    return { http: r, result: first };
  }

  try {
    // ── 1. Enroll device + auth guards ─────────────────────────────
    console.log('\n── 1. Device enrollment (officer-auth) ──');
    const e1 = await post(ENROLL_DEVICE_PATH, { deviceId: DEV_A, publicKeyPem: keysA.publicKeyPem }, token('officer', 'RDF'));
    check('enroll DEV_A → 201 ENROLLED', e1.status === 201 && asRecord(e1.json)['status'] === 'ENROLLED', `${e1.status} ${e1.text}`);
    const e1b = await post(ENROLL_DEVICE_PATH, { deviceId: DEV_A, publicKeyPem: keysA.publicKeyPem }, token('officer', 'RDF'));
    check('re-enroll DEV_A → 200 ALREADY_ENROLLED (idempotent)', e1b.status === 200 && asRecord(e1b.json)['status'] === 'ALREADY_ENROLLED');
    const e2 = await post(ENROLL_DEVICE_PATH, { deviceId: DEV_B, publicKeyPem: keysB.publicKeyPem }, token('officer', 'RDF'));
    check('enroll DEV_B → 201', e2.status === 201);
    check('no token → 401', (await post(ENROLL_DEVICE_PATH, { deviceId: 'x', publicKeyPem: 'y' })).status === 401);
    check('system token → 403 (officer-only)', (await post(ENROLL_DEVICE_PATH, { deviceId: 'x', publicKeyPem: 'y' }, token('system'))).status === 403);

    // ── 2. Sign → sync → stored + event + application advances ──────
    console.log('\n── 2. Enroll→sign→sync→stored + FIELD_SCORE_CAPTURED → PHYSICAL_TEST_COMPLETE ──');
    const recAccept = makeRecord(APP_ACCEPT, keysA.privateKeyPem, DEV_A, { [DEV_A]: 1 });
    const s2 = await syncOne(recAccept);
    check('sync → 200', s2.http.status === 200, `${s2.http.status} ${s2.http.text}`);
    check('record ACCEPTED', s2.result['status'] === 'ACCEPTED', JSON.stringify(s2.result));
    const capEvent = busMain.published.find(
      (e) => e.eventType === 'FIELD_SCORE_CAPTURED' && asRecord(e)['applicationId'] === APP_ACCEPT,
    );
    check('FIELD_SCORE_CAPTURED emitted', capEvent !== undefined);
    check('event carries signedPayloadHash', asRecord(capEvent)['signedPayloadHash'] === recAccept.signedPayloadHash);
    check('event isWalkIn false', asRecord(capEvent)['isWalkIn'] === false);
    check('event campaignId set', asRecord(capEvent)['campaignId'] === CAMPAIGN_ID);
    const storedRows = await admin<{ id: string; hash: string }[]>`
      SELECT id, signed_payload_hash AS hash FROM rdf_ops.physical_test_scores WHERE application_id = ${APP_ACCEPT}`;
    check('score row stored', storedRows.length === 1 && storedRows[0]?.hash === recAccept.signedPayloadHash);
    check('application advanced → PHYSICAL_TEST_COMPLETE', (await appStatus(APP_ACCEPT)) === 'PHYSICAL_TEST_COMPLETE');
    check('physical_test_score_id stamped to the stored row', (await appScoreId(APP_ACCEPT)) === storedRows[0]?.id);
    check('AUDIT_ENTRY (capture) emitted', busMain.published.some((e) => e.eventType === 'AUDIT_ENTRY' && asRecord(e)['action'] === 'FIELD_SCORE_CAPTURED'));
    check('status-history has the transition', (await admin`SELECT 1 FROM rdf_ops.application_status_history WHERE application_id=${APP_ACCEPT} AND to_status='PHYSICAL_TEST_COMPLETE'`).length === 1);

    // ── 3. Idempotency: duplicate re-upload is a no-op ─────────────
    console.log('\n── 3. Duplicate resync → DUPLICATE (idempotent) ──');
    const dup = await syncOne(recAccept);
    check('same record again → DUPLICATE', dup.result['status'] === 'DUPLICATE', JSON.stringify(dup.result));
    check('no second row inserted', (await admin`SELECT count(*)::int AS n FROM rdf_ops.physical_test_scores WHERE application_id=${APP_ACCEPT}`)[0]?.['n'] === 1);
    check('application unchanged (still COMPLETE)', (await appStatus(APP_ACCEPT)) === 'PHYSICAL_TEST_COMPLETE');

    // ── 4. Out-of-order convergence: supersede + stale ─────────────
    console.log('\n── 4. Out-of-order resync converges (supersede / stale) ──');
    const rOrder1 = makeRecord(APP_ORDER, keysA.privateKeyPem, DEV_A, { [DEV_A]: 1 });
    const rOrder2 = makeRecord(APP_ORDER, keysA.privateKeyPem, DEV_A, { [DEV_A]: 2 }, { ...METRICS, run3kmTimeSeconds: 690 });
    // The newer (clock-2) correction lands first; the older (clock-1) arrives
    // late — it must NOT overwrite the head. Convergence is order-independent.
    check('clock-2 correction first → ACCEPTED', (await syncOne(rOrder2)).result['status'] === 'ACCEPTED');
    check('clock-1 arriving late → STALE (dominated, not stored)', (await syncOne(rOrder1)).result['status'] === 'STALE');
    check('re-sending the late clock-1 again → STALE (idempotent)', (await syncOne(rOrder1)).result['status'] === 'STALE');
    check('only the clock-2 record is stored (clock-1 never persisted)', (await admin`SELECT count(*)::int AS n FROM rdf_ops.physical_test_scores WHERE application_id=${APP_ORDER}`)[0]?.['n'] === 1);
    check('clock-2 record is the clean head', (await admin`SELECT 1 FROM rdf_ops.physical_test_scores WHERE application_id=${APP_ORDER} AND signed_payload_hash=${rOrder2.signedPayloadHash} AND sync_conflict_detected=false`).length === 1);

    // ── 5. Concurrent captures → conflict + HELD → resolve → advance ─
    console.log('\n── 5. Concurrent captures → conflict flagged + application HELD ──');
    const recA = makeRecord(APP_CONFLICT, keysA.privateKeyPem, DEV_A, { [DEV_A]: 1 });
    const recBconc = makeRecord(APP_CONFLICT, keysB.privateKeyPem, DEV_B, { [DEV_B]: 1 }, { ...METRICS, run3kmTimeSeconds: 705 });
    const cA = await fsQuiet.syncFieldScores.sync({ records: [recA], actorAgency: 'RDF', context: { correlationId: 'c5', causationId: 'c5' } });
    check('devA record ACCEPTED (quiet bus, no auto-advance)', cA.results[0]?.status === 'ACCEPTED');
    const cB = await fsQuiet.syncFieldScores.sync({ records: [recBconc], actorAgency: 'RDF', context: { correlationId: 'c5', causationId: 'c5' } });
    const bConf = cB.results[0];
    check('devB concurrent record → CONFLICT', bConf?.status === 'CONFLICT', JSON.stringify(bConf));
    const conflictCapEvents = busQuiet.published.filter((e) => e.eventType === 'FIELD_SCORE_CAPTURED' && asRecord(e)['applicationId'] === APP_CONFLICT);
    check('NO FIELD_SCORE_CAPTURED emitted for the conflict record (only the first clean one)', conflictCapEvents.length === 1);
    check('both rows flagged sync_conflict_detected=true', (await admin`SELECT count(*)::int AS n FROM rdf_ops.physical_test_scores WHERE application_id=${APP_CONFLICT} AND sync_conflict_detected=true`)[0]?.['n'] === 2);
    check('application still PHYSICAL_TEST_SCHEDULED (never advanced)', (await appStatus(APP_CONFLICT)) === 'PHYSICAL_TEST_SCHEDULED');
    // Even a clean-score event cannot complete a conflicted application (engine hold).
    const held = await appService.physicalTestProjector.project({
      result: { applicationId: APP_CONFLICT, agency: 'RDF', signedPayloadHash: recA.signedPayloadHash, correlationId: 'c5' },
      agency: 'RDF', context: { correlationId: 'c5', causationId: 'c5' },
    });
    check('projector refuses to complete while conflict pending → CONFLICT_HELD', held.kind === 'CONFLICT_HELD', held.kind);

    console.log('\n── 5b. Officer resolves the conflict → application advances ──');
    const scoreAId = cA.results[0]?.scoreId as string;
    const rr = await post(RESOLVE_CONFLICT_PATH, { applicationId: APP_CONFLICT, scoreId: scoreAId, resolution: 'MANUAL_PICK_A' }, token('officer', 'RDF'));
    check('resolve → 200 RESOLVED', rr.status === 200 && asRecord(rr.json)['status'] === 'RESOLVED', `${rr.status} ${rr.text}`);
    check('conflict flags cleared', (await admin`SELECT count(*)::int AS n FROM rdf_ops.physical_test_scores WHERE application_id=${APP_CONFLICT} AND sync_conflict_detected=true`)[0]?.['n'] === 0);
    check('resolution recorded on chosen record', (await admin`SELECT sync_conflict_resolution AS r FROM rdf_ops.physical_test_scores WHERE id=${scoreAId}`)[0]?.['r'] === 'MANUAL_PICK_A');
    check('application advanced → PHYSICAL_TEST_COMPLETE', (await appStatus(APP_CONFLICT)) === 'PHYSICAL_TEST_COMPLETE');
    check('stamped with the officer-chosen score row', (await appScoreId(APP_CONFLICT)) === scoreAId);
    // Resolving a clean application → NO_CONFLICT.
    const rr2 = await post(RESOLVE_CONFLICT_PATH, { applicationId: APP_ACCEPT, scoreId: storedRows[0]?.id, resolution: 'x' }, token('officer', 'RDF'));
    check('resolve on a non-conflicted app → 409 NO_CONFLICT', rr2.status === 409 && asRecord(rr2.json)['status'] === 'NO_CONFLICT', `${rr2.status} ${rr2.text}`);

    // ── 6. Rejections: tamper / unenrolled / revoked / cross-agency ─
    console.log('\n── 6. Integrity rejections (never stored) ──');
    const tampered = makeRecord(APP_ACCEPT, keysA.privateKeyPem, DEV_A, { [DEV_A]: 5 });
    const forged = { ...tampered, metrics: { ...tampered.metrics, run3kmTimeSeconds: 1 } }; // metrics changed after signing
    check('tampered metrics → REJECTED BAD_SIGNATURE', (await syncOne(forged)).result['reason'] === 'BAD_SIGNATURE');
    const ghost = makeRecord(APP_ACCEPT, keysA.privateKeyPem, DEV_UNENROLLED, { [DEV_UNENROLLED]: 1 });
    check('unenrolled device → REJECTED UNENROLLED_DEVICE', (await syncOne(ghost)).result['reason'] === 'UNENROLLED_DEVICE');
    const revoked = makeRecord(APP_ACCEPT, keysRevoked.privateKeyPem, DEV_REVOKED, { [DEV_REVOKED]: 1 });
    check('revoked device → REJECTED REVOKED_DEVICE', (await syncOne(revoked)).result['reason'] === 'REVOKED_DEVICE');
    // DEV_A is enrolled under RDF; an RNP officer syncing it → agency mismatch.
    const mismatch = await syncOne(makeRecord(APP_ACCEPT, keysA.privateKeyPem, DEV_A, { [DEV_A]: 9 }), token('officer', 'RNP'));
    check('RNP officer + RDF device → REJECTED AGENCY_MISMATCH', mismatch.result['reason'] === 'AGENCY_MISMATCH', JSON.stringify(mismatch.result));
    // A well-formed record for an application absent from the officer's agency schema.
    const crossApp = makeRecord('5f000000-0000-4000-8000-0000dead0001', keysA.privateKeyPem, DEV_A, { [DEV_A]: 1 });
    check('unknown application in agency schema → NOT_FOUND', (await syncOne(crossApp)).result['status'] === 'NOT_FOUND');

    // ── 7. Biometric precondition ──────────────────────────────────
    console.log('\n── 7. Biometric-pass precondition enforced ──');
    const recNoBio = makeRecord(APP_NOBIO, keysA.privateKeyPem, DEV_A, { [DEV_A]: 1 });
    const sNoBio = await syncOne(recNoBio);
    check('score accepted + stored (field-sync owns the score)', sNoBio.result['status'] === 'ACCEPTED', JSON.stringify(sNoBio.result));
    check('but application HELD at PHYSICAL_TEST_SCHEDULED (no biometric pass)', (await appStatus(APP_NOBIO)) === 'PHYSICAL_TEST_SCHEDULED');
    const bioOut = await appService.physicalTestProjector.project({
      result: { applicationId: APP_NOBIO, agency: 'RDF', signedPayloadHash: recNoBio.signedPayloadHash, correlationId: 'c7' },
      agency: 'RDF', context: { correlationId: 'c7', causationId: 'c7' },
    });
    check('projector → BIOMETRIC_NOT_VERIFIED (fail-closed hold)', bioOut.kind === 'BIOMETRIC_NOT_VERIFIED', bioOut.kind);

    // ── 8. No raw PII / frames leak into events ────────────────────
    console.log('\n── 8. Events carry scores/ids only — no PII ──');
    const blob = JSON.stringify(busMain.published);
    check('no national_id_hash in any event', !blob.includes('a1a1a1') && !blob.includes('a2a2a2'));
  } finally {
    await server.stop();
    await cleanup();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('FIELD-SYNC OFFLINE CAPTURE + CRDT MERGE + CONFLICT ADJUDICATION PROVEN ✓');
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
