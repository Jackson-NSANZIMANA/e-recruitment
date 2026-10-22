// ══════════════════════════════════════════════════════════════════
// field-sync-service — Device fleet and venue live counts (S09, rls/0036)
//
// Live Postgres, real sockets, the real routes:
//   • field.device.manage gates list / assign / revoke (screening_officer 403;
//     field_supervisor and agency_admin 200); agency from the token only;
//   • list is agency-scoped (engine RLS) and never carries the key;
//   • revoke needs a CLOSED reason, is final, audited in the transactional
//     outbox, and a sibling agency's device is a bare 404 (and stays active);
//   • a revoked device is refused on its NEXT score sync and its id can never be
//     enrolled again (the biometric side is proven in verify-biometric-evidence
//     and, live, by `pnpm rehearse --fleet`);
//   • last-seen is stamped only by a SIGNED contact, never for a forger or a
//     revoked device, monotonic, and biometric-service's role can stamp but not
//     update the table;
//   • the engine refuses to change a key, an agency or a revocation;
//   • assignment binds a device to one venue day (unknown venue 404, revoked 409);
//   • the venue live-count projection follows every roster, admission, score
//     and conflict event in the same transaction, carries an advancing asOf, is
//     RLS-scoped per agency, and cannot be written by an officer role;
//   • GET /v1/venue-live-counts answers counts + asOf and nothing about a person.
//
//   DATABASE_URL=… ADMIN_DATABASE_URL=… (BOTH set to a throwaway DB)
//   npx tsx services/field-sync-service/selfcheck/verify-device-fleet.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair, signFieldScoreRecord, type SignableFieldPayload } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import type { FieldScoreRecord, PhysicalTestMetrics } from '@usrp/shared-types';
import {
  createFieldSyncService,
  enrollDeviceRoute,
  syncScoresRoute,
  manageFleetRoutes,
  ENROLL_DEVICE_PATH,
  SYNC_SCORES_PATH,
  LIST_FLEET_PATH,
  ASSIGN_DEVICE_PATH,
  REVOKE_DEVICE_PATH,
  loadFieldSyncConfig,
} from '../src/index.js';
import { createApplicationService, loadApplicationConfig, operationalReadRoutes } from '@usrp/application-service';

const AUTH_KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(AUTH_KEYS.publicKeyPem, 'utf8').toString('base64');
process.env['JWT_ISSUER'] ??= 'usrp';
process.env['JWT_AUDIENCE'] ??= 'usrp-services';
process.env['DATABASE_URL'] ??= 'postgresql://usrp_app:app_pw@localhost:5432/usrp_db';

const admin = postgres(
  process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db',
  { onnotice: () => {} },
);

const CAMPAIGN = '59000000-0000-4000-8000-0000000000c0';
const CAMPAIGN_CODE = 'S09-FLEET-RDF';
const RNP_CAMPAIGN = '59000000-0000-4000-8000-0000000000c1';
const DISTRICT = 'GASABO';
const OTHER_DISTRICT = 'KICUKIRO';
const EXAM_DAY = '2026-11-05';
const APPLICANTS = [1, 2, 3, 4].map((n) => `59000000-0000-4000-8000-00000000b00${String(n)}`);
const APPS = [1, 2, 3, 4].map((n) => `59000000-0000-4000-8000-00000000a00${String(n)}`);
const OFFICER_ID = '59000000-0000-4000-8000-00000000ff01';

const DEV_OK = 'S09-DEV-OK';
const DEV_FORGER = 'S09-DEV-FORGER';
const DEV_RNP = 'S09-DEV-RNP';
const DEV_NEW = 'S09-DEV-NEW';
const DEVICES = [DEV_OK, DEV_FORGER, DEV_RNP, DEV_NEW];
const keysOk = generateDeviceKeyPair();
const keysForger = generateDeviceKeyPair();
const keysRnp = generateDeviceKeyPair();
const keysNew = generateDeviceKeyPair();

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function token(roles: string[], agency: 'RDF' | 'RNP' = 'RDF'): string {
  const claims: AuthTokenClaims = {
    v: 1, iss: 'usrp', aud: 'usrp-services', sub: OFFICER_ID,
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
    kind: 'officer', agency, roles,
  };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}
const SUPERVISOR = token(['field_supervisor']);
const ADMIN_TOKEN = token(['agency_admin']);
const SCREENING = token(['screening_officer']);
const RNP_SUPERVISOR = token(['field_supervisor'], 'RNP');

const METRICS: PhysicalTestMetrics = { heightCm: 178, weightKg: 72, run3kmTimeSeconds: 720, chestCm: 96, medicalFitnessStatus: 'FIT' };
function signedRecord(applicationId: string, privateKeyPem: string, deviceId: string, signWith = privateKeyPem): FieldScoreRecord {
  const payload: SignableFieldPayload = {
    applicationId, qrInvitationCode: 'S09-NO-SUCH-TICKET', metrics: METRICS, capturedAt: '2026-11-05T09:00:00.000Z',
    deviceId, capturingOfficerId: OFFICER_ID, vectorClock: { [deviceId]: 1 },
  };
  const sig = signFieldScoreRecord(signWith, payload);
  return { ...payload, deviceSignature: sig.deviceSignature, signedPayloadHash: sig.signedPayloadHash };
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM rdf_ops.physical_test_scores WHERE application_id = ANY(${APPS}::uuid[])`;
    await tx`DELETE FROM rdf_ops.gate_admissions WHERE application_id = ANY(${APPS}::uuid[])`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id = ANY(${APPS}::uuid[])`;
    await tx`DELETE FROM rdf_ops.applications WHERE id = ANY(${APPS}::uuid[])`;
    await tx`DELETE FROM public_core.venue_day_counts WHERE campaign_id IN (${CAMPAIGN}, ${RNP_CAMPAIGN})`;
    await tx`DELETE FROM public_core.field_device_assignments WHERE device_id = ANY(${DEVICES})`;
    await tx`DELETE FROM public_core.campaign_venue_assignments WHERE campaign_id IN (${CAMPAIGN}, ${RNP_CAMPAIGN})`;
    await tx`DELETE FROM public_core.event_outbox WHERE payload->>'entityId' = ANY(${DEVICES})`;
    await tx`DELETE FROM public_core.field_devices WHERE device_id = ANY(${DEVICES})`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN (${CAMPAIGN}, ${RNP_CAMPAIGN})`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ANY(${APPLICANTS}::uuid[])`;
  });
}

async function seed(): Promise<void> {
  await cleanup();
  for (const [i, id] of APPLICANTS.entries()) {
    await admin`
      INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth, encrypted_home_district,
         encrypted_home_province, gender, registration_channel, identity_status)
      VALUES (${id}, ${`b${String(i)}`.repeat(32).slice(0, 64)}, 'x','x','x','x','MALE','WEB',
              'VERIFIED'::public_core.identity_verification_status)`;
  }
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO public_core.recruitment_campaigns
        (id, public_code, campaign_label, agency, target_categories, registration_opens_at, registration_closes_at,
         examination_start_date, examination_end_date, examination_reporting_hour, status)
      VALUES
        (${CAMPAIGN}, ${CAMPAIGN_CODE}, 'S09 fleet RDF', 'RDF', '["GENERAL_ENLISTMENT"]', now() - interval '10 days',
         now() + interval '10 days', ${EXAM_DAY}, '2026-11-09', 8, 'REGISTRATION_OPEN'::public_core.campaign_status),
        (${RNP_CAMPAIGN}, 'S09-FLEET-RNP', 'S09 fleet RNP', 'RNP', '["CADET_OFFICER"]', now() - interval '10 days',
         now() + interval '10 days', ${EXAM_DAY}, '2026-11-09', 8, 'REGISTRATION_OPEN'::public_core.campaign_status)`;
    await tx`
      INSERT INTO public_core.campaign_venue_assignments (campaign_id, district, province, venue_name, exam_date, reporting_time_hour)
      VALUES (${CAMPAIGN}, ${DISTRICT}, 'KIGALI_CITY', 'S09 Gasabo venue', ${EXAM_DAY}, 8),
             (${RNP_CAMPAIGN}, ${DISTRICT}, 'KIGALI_CITY', 'S09 RNP venue', ${EXAM_DAY}, 8)`;
  });
  // RNP device (sibling agency), enrolled directly.
  await admin`
    INSERT INTO public_core.field_devices (device_id, public_key_pem, agency, enrolled_by)
    VALUES (${DEV_RNP}, ${keysRnp.publicKeyPem}, 'RNP', ${OFFICER_ID})`;
}

const insertApp = (n: number, status: string, district: string | null) => admin`
  INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status, assigned_district)
  VALUES (${APPS[n] ?? ''}, ${`RDF-9${String(n)}900`}, ${APPLICANTS[n] ?? ''}, ${CAMPAIGN},
          'GENERAL_ENLISTMENT'::rdf_ops.application_category, ${status}::rdf_ops.application_status, ${district})`;

interface Counts { expected: number; admitted: number; physical_captured: number; medical_recorded: number; open_conflicts: number; as_of: Date }
async function counts(): Promise<Counts | null> {
  const rows = await admin<Counts[]>`
    SELECT expected, admitted, physical_captured, medical_recorded, open_conflicts, as_of
    FROM public_core.venue_day_counts WHERE campaign_id = ${CAMPAIGN} AND district = ${DISTRICT}`;
  return rows[0] ?? null;
}
async function device(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await admin<Record<string, unknown>[]>`SELECT * FROM public_core.field_devices WHERE device_id = ${id}`;
  return rows[0];
}

async function main(): Promise<void> {
  await seed();
  const bus = new InMemoryEventBus();
  const verify = makeAuthVerifier({ publicKeyPem: AUTH_KEYS.publicKeyPem, issuer: 'usrp', audience: 'usrp-services' });
  const fs = createFieldSyncService(loadFieldSyncConfig(), bus);
  const app = createApplicationService(loadApplicationConfig(), bus);
  const server = await startHttpServer({
    serviceName: 'fleet-selfcheck', port: 0, host: '127.0.0.1', handleSignals: false,
    routes: [
      enrollDeviceRoute(fs.enrollDevice, verify),
      syncScoresRoute(fs.syncFieldScores, verify),
      ...manageFleetRoutes(fs.manageFleet, verify),
      ...operationalReadRoutes(app.operationalReads, verify),
    ],
  });
  const call = async (method: 'GET' | 'POST', path: string, auth?: string, body?: unknown) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, text, json };
  };
  const sync = async (r: FieldScoreRecord) => {
    const res = await call('POST', SYNC_SCORES_PATH, SUPERVISOR, { records: [r] });
    const results = rec(res.json)['results'];
    return Array.isArray(results) ? rec(results[0]) : {};
  };
  const listFleet = async (auth = SUPERVISOR) => {
    const res = await call('GET', LIST_FLEET_PATH, auth);
    const devices = rec(res.json)['devices'];
    return { res, devices: Array.isArray(devices) ? devices.map(rec) : [] };
  };

  try {
    console.log('\n── 1. field.device.manage gates the three operations ──');
    await call('POST', ENROLL_DEVICE_PATH, SCREENING, { deviceId: DEV_OK, publicKeyPem: keysOk.publicKeyPem });
    await call('POST', ENROLL_DEVICE_PATH, SCREENING, { deviceId: DEV_FORGER, publicKeyPem: keysForger.publicKeyPem });
    check('screening_officer still enrols (field.device.enroll unchanged)', (await device(DEV_OK)) !== undefined);
    check('screening_officer cannot list → 403', (await call('GET', LIST_FLEET_PATH, SCREENING)).status === 403);
    check('screening_officer cannot assign → 403',
      (await call('POST', ASSIGN_DEVICE_PATH, SCREENING, { deviceId: DEV_OK, campaign: CAMPAIGN_CODE, district: DISTRICT, examDate: EXAM_DAY })).status === 403);
    check('screening_officer cannot revoke → 403',
      (await call('POST', REVOKE_DEVICE_PATH, SCREENING, { deviceId: DEV_OK, reason: 'LOST' })).status === 403);
    check('no token → 401', (await call('GET', LIST_FLEET_PATH)).status === 401);
    check('field_supervisor lists → 200', (await listFleet(SUPERVISOR)).res.status === 200);
    check('agency_admin lists → 200', (await listFleet(ADMIN_TOKEN)).res.status === 200);

    console.log('\n── 2. List is agency-scoped and never carries the key ──');
    const rdf = await listFleet(SUPERVISOR);
    const ids = rdf.devices.map((d) => d['deviceId']);
    check('RDF supervisor sees its own devices', ids.includes(DEV_OK) && ids.includes(DEV_FORGER));
    check('RDF supervisor does not see the RNP device', !ids.includes(DEV_RNP));
    check('the public key is not in the answer', !rdf.res.text.includes('BEGIN PUBLIC KEY') && !rdf.res.text.includes('publicKey'));
    const rnp = await listFleet(RNP_SUPERVISOR);
    check('RNP supervisor sees only the RNP device',
      rnp.devices.some((d) => d['deviceId'] === DEV_RNP) && !rnp.devices.some((d) => d['deviceId'] === DEV_OK));
    const okRow = rdf.devices.find((d) => d['deviceId'] === DEV_OK);
    check('a fresh device has never been seen', okRow?.['lastSeenAt'] === null && okRow?.['revokedAt'] === null && okRow?.['assignment'] === null);

    console.log('\n── 3. Last seen: signed contact only, monotonic ──');
    const forged = signedRecord(APPS[0] ?? '', keysForger.privateKeyPem, DEV_FORGER, keysOk.privateKeyPem);
    check('forged signature → REJECTED BAD_SIGNATURE', (await sync(forged))['reason'] === 'BAD_SIGNATURE');
    check('a forger does not make the device look alive', (await device(DEV_FORGER))?.['last_seen_at'] === null);
    const genuine = await sync(signedRecord(APPS[0] ?? '', keysOk.privateKeyPem, DEV_OK));
    check('a genuine signed record passes the device checks (NOT_FOUND application)', genuine['status'] === 'NOT_FOUND', JSON.stringify(genuine));
    const seen1 = await device(DEV_OK);
    check('score sync stamps last_seen_at, last_sync_at and the source',
      seen1?.['last_seen_at'] instanceof Date && seen1?.['last_sync_at'] instanceof Date && seen1?.['last_seen_source'] === 'FIELD_SYNC');
    await sync(signedRecord(APPS[0] ?? '', keysOk.privateKeyPem, DEV_OK));
    const seen2 = await device(DEV_OK);
    check('last_seen_at never moves backwards', (seen2?.['last_seen_at'] as Date).getTime() >= (seen1?.['last_seen_at'] as Date).getTime());
    await admin.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_biometric_service`;
      await tx`SELECT public_core.touch_field_device(${DEV_OK}, 'BIOMETRIC')`;
    });
    check('biometric-service role stamps with its own source', (await device(DEV_OK))?.['last_seen_source'] === 'BIOMETRIC');
    let biometricUpdateDenied = false;
    try {
      await admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_biometric_service`;
        await tx`UPDATE public_core.field_devices SET last_seen_at = now() WHERE device_id = ${DEV_OK}`;
      });
    } catch { biometricUpdateDenied = true; }
    check('biometric-service role cannot UPDATE the table directly', biometricUpdateDenied);
    let badSourceStamp = true;
    await admin.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_system_service`;
      await tx`SELECT public_core.touch_field_device(${DEV_OK}, 'SOMETHING_ELSE')`;
    });
    badSourceStamp = (await device(DEV_OK))?.['last_seen_source'] === 'SOMETHING_ELSE';
    check('an unknown source stamps nothing', !badSourceStamp);

    console.log('\n── 4. Assignment binds one venue day ──');
    const assign = (deviceId: string, campaign = CAMPAIGN_CODE, district = DISTRICT, auth = SUPERVISOR) =>
      call('POST', ASSIGN_DEVICE_PATH, auth, { deviceId, campaign, district, examDate: EXAM_DAY });
    check('assign → 200 ASSIGNED', (await assign(DEV_OK)).status === 200);
    check('assign again is idempotent', (await assign(DEV_OK)).status === 200);
    check('unknown venue → bare 404', (await assign(DEV_OK, CAMPAIGN_CODE, OTHER_DISTRICT)).status === 404);
    check('unknown campaign → bare 404', (await assign(DEV_OK, 'NO-SUCH-CAMPAIGN')).status === 404);
    check('sibling agency device → bare 404', (await assign(DEV_RNP)).status === 404);
    check('RNP supervisor cannot bind to an RDF campaign → 404', (await assign(DEV_RNP, CAMPAIGN_CODE, DISTRICT, RNP_SUPERVISOR)).status === 404);
    check('unknown key in the body → 400',
      (await call('POST', ASSIGN_DEVICE_PATH, SUPERVISOR, { deviceId: DEV_OK, campaign: CAMPAIGN_CODE, district: DISTRICT, examDate: EXAM_DAY, agency: 'RNP' })).status === 400);
    const assigned = (await listFleet()).devices.find((d) => d['deviceId'] === DEV_OK);
    const a = rec(assigned?.['assignment']);
    check('the list shows the binding', a['campaignPublicCode'] === CAMPAIGN_CODE && a['district'] === DISTRICT && a['examDate'] === EXAM_DAY, JSON.stringify(a));
    const assignAudit = await admin`SELECT 1 FROM public_core.event_outbox WHERE payload->>'action' = 'FIELD_DEVICE_ASSIGNED' AND payload->>'entityId' = ${DEV_OK}`;
    check('the assignment is audited through the outbox', assignAudit.length >= 1);

    console.log('\n── 5. Revocation: reason required, final, audited, next contact refused ──');
    const revoke = (deviceId: string, reason: unknown, auth = SUPERVISOR) => call('POST', REVOKE_DEVICE_PATH, auth, { deviceId, ...(reason === undefined ? {} : { reason }) });
    check('no reason → 400', (await revoke(DEV_OK, undefined)).status === 400);
    check('free-text reason → 400', (await revoke(DEV_OK, 'dropped it in the lake')).status === 400);
    check('still active after the refusals', (await device(DEV_OK))?.['revoked_at'] === null);
    check('sibling agency cannot revoke → bare 404', (await revoke(DEV_OK, 'LOST', RNP_SUPERVISOR)).status === 404);
    check('and the device is still active', (await device(DEV_OK))?.['revoked_at'] === null);
    const revoked = await revoke(DEV_OK, 'STOLEN');
    check('revoke → 200 REVOKED', revoked.status === 200 && rec(revoked.json)['status'] === 'REVOKED', revoked.text);
    const row = await device(DEV_OK);
    check('revoked_at, revoked_by and reason are recorded',
      row?.['revoked_at'] instanceof Date && row?.['revoked_by'] === OFFICER_ID && row?.['revoke_reason'] === 'STOLEN');
    const again = await revoke(DEV_OK, 'LOST');
    check('revoking again is ALREADY_REVOKED and keeps the first reason',
      rec(again.json)['status'] === 'ALREADY_REVOKED' && (await device(DEV_OK))?.['revoke_reason'] === 'STOLEN');
    const audit = await admin<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM public_core.event_outbox WHERE payload->>'action' = 'FIELD_DEVICE_REVOKED' AND payload->>'entityId' = ${DEV_OK}`;
    check('exactly one FIELD_DEVICE_REVOKED audit, staged in the outbox', audit.length === 1);
    check('the audit carries the reason code, the actor and the agency, and no key',
      rec(audit[0]?.payload['metadata'])['reason'] === 'STOLEN' && audit[0]?.payload['performedBy'] === OFFICER_ID
      && audit[0]?.payload['agency'] === 'RDF' && !JSON.stringify(audit[0]?.payload).includes('PUBLIC KEY'));
    const listed = (await listFleet()).devices.find((d) => d['deviceId'] === DEV_OK);
    check('the list shows it revoked with its reason', listed?.['revokeReason'] === 'STOLEN' && typeof listed?.['revokedAt'] === 'string');
    const lastSeenBefore = (await device(DEV_OK))?.['last_seen_at'] as Date;
    const refused = await sync(signedRecord(APPS[0] ?? '', keysOk.privateKeyPem, DEV_OK));
    check('NEXT score sync from the revoked device → REJECTED REVOKED_DEVICE', refused['status'] === 'REJECTED' && refused['reason'] === 'REVOKED_DEVICE', JSON.stringify(refused));
    check('a revoked contact does not refresh last seen', ((await device(DEV_OK))?.['last_seen_at'] as Date).getTime() === lastSeenBefore.getTime());
    const reenrol = await call('POST', ENROLL_DEVICE_PATH, SCREENING, { deviceId: DEV_OK, publicKeyPem: keysNew.publicKeyPem });
    check('re-enrolling a revoked id → 409 DEVICE_REVOKED', reenrol.status === 409 && rec(reenrol.json)['error'] === 'DEVICE_REVOKED', reenrol.text);
    const probe = await call('POST', ENROLL_DEVICE_PATH, token(['screening_officer'], 'RNP'), { deviceId: DEV_OK, publicKeyPem: keysNew.publicKeyPem });
    check("a sibling agency cannot probe a revoked id (no 409)", probe.status !== 409, probe.text);
    check('and its key is unchanged', (await device(DEV_OK))?.['public_key_pem'] === keysOk.publicKeyPem);
    check('assigning a revoked device → 409', (await assign(DEV_OK)).status === 409);
    const enrolNew = await call('POST', ENROLL_DEVICE_PATH, SCREENING, { deviceId: DEV_NEW, publicKeyPem: keysNew.publicKeyPem });
    check('the replacement tablet enrols under a NEW id', enrolNew.status === 201);

    console.log('\n── 6. The engine guards the registry ──');
    const denied = async (run: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<boolean> => {
      try { await admin.begin(async (tx) => { await tx`SET LOCAL ROLE usrp_system_service`; await run(tx); }); return false; } catch { return true; }
    };
    check('the key cannot be replaced', await denied((tx) => tx`UPDATE public_core.field_devices SET public_key_pem = 'x' WHERE device_id = ${DEV_NEW}`));
    check('the agency cannot be moved', await denied((tx) => tx`UPDATE public_core.field_devices SET agency = 'RNP' WHERE device_id = ${DEV_NEW}`));
    check('a revocation cannot be undone', await denied((tx) => tx`UPDATE public_core.field_devices SET revoked_at = NULL WHERE device_id = ${DEV_OK}`));
    check('a revocation reason cannot be rewritten', await denied((tx) => tx`UPDATE public_core.field_devices SET revoke_reason = 'RETIRED' WHERE device_id = ${DEV_OK}`));
    check('an unknown reason code is refused by the CHECK', await denied((tx) => tx`UPDATE public_core.field_devices SET revoked_at = now(), revoked_by = 'x', revoke_reason = 'BORED' WHERE device_id = ${DEV_NEW}`));

    console.log('\n── 7. Venue live counts: the projection follows every event ──');
    check('no row before any event', (await counts()) === null);
    await admin`DELETE FROM public_core.venue_day_counts WHERE campaign_id = ${CAMPAIGN}`;
    await insertApp(0, 'SLOT_ASSIGNED', DISTRICT);
    await insertApp(1, 'PHYSICAL_TEST_SCHEDULED', DISTRICT);
    await insertApp(2, 'PHYSICAL_TEST_SCHEDULED', DISTRICT);
    await insertApp(3, 'SLOT_ASSIGNED', OTHER_DISTRICT);
    let c = await counts();
    check('expected counts the roster of THIS venue only (3, not the Kicukiro candidate)', c?.expected === 3 && c.admitted === 0, JSON.stringify(c));
    const asOf0 = c?.as_of.getTime() ?? 0;
    for (const n of [1, 2]) {
      await admin`
        INSERT INTO rdf_ops.gate_admissions (application_id, ticket_id, campaign_id, venue_name, exam_date, identity_method, admitted_by_id)
        VALUES (${APPS[n] ?? ''}, ${`S09-T-${String(n)}`}, ${CAMPAIGN}, 'S09 Gasabo venue', ${EXAM_DAY}, 'NATIONAL_ID_CARD', ${OFFICER_ID})`;
    }
    c = await counts();
    check('two admissions → admitted = 2', c?.admitted === 2 && c.expected === 3, JSON.stringify(c));
    check('asOf advanced', (c?.as_of.getTime() ?? 0) >= asOf0 && (c?.as_of.getTime() ?? 0) > 0);
    const insertScore = (n: number, device: string, clock: Record<string, number>, medical: string | null, conflict: boolean, hash: string) => admin`
      INSERT INTO rdf_ops.physical_test_scores
        (application_id, vector_clock, device_id, height_cm, weight_kg, run_3km_time_seconds, chest_cm, medical_fitness_status,
         device_signature, signed_payload_hash, capturing_officer_id, captured_at, sync_conflict_detected)
      VALUES (${APPS[n] ?? ''}, ${admin.json(clock)}, ${device}, 178, 72, 720, 96, ${medical}, 'sig', ${hash}, ${OFFICER_ID}, now(), ${conflict})`;
    await insertScore(1, DEV_NEW, { a: 1 }, 'FIT', false, 'h1');
    await insertScore(1, DEV_NEW, { a: 2 }, 'FIT', false, 'h2'); // a superseding row, same candidate
    c = await counts();
    check('two score rows for ONE candidate count once (physical = 1, medical = 1)', c?.physical_captured === 1 && c.medical_recorded === 1, JSON.stringify(c));
    await insertScore(2, DEV_NEW, { a: 1 }, null, true, 'h3');
    c = await counts();
    check('a second candidate with an open conflict and no medical → physical 2, medical 1, conflicts 1',
      c?.physical_captured === 2 && c.medical_recorded === 1 && c.open_conflicts === 1, JSON.stringify(c));
    await admin`UPDATE rdf_ops.physical_test_scores SET sync_conflict_detected = false WHERE application_id = ${APPS[2] ?? ''}`;
    c = await counts();
    check('resolving the conflict clears it', c?.open_conflicts === 0, JSON.stringify(c));
    await admin`UPDATE rdf_ops.applications SET assigned_district = ${OTHER_DISTRICT} WHERE id = ${APPS[0] ?? ''}`;
    c = await counts();
    check('a candidate moved to another venue leaves this roster (expected 2)', c?.expected === 2, JSON.stringify(c));
    await admin`UPDATE rdf_ops.applications SET status = 'REJECTED'::rdf_ops.application_status WHERE id = ${APPS[2] ?? ''}`;
    c = await counts();
    check('a candidate leaving the roster statuses reduces expected (1)', c?.expected === 1, JSON.stringify(c));

    console.log('\n── 8. The projection is RLS-scoped and write-protected ──');
    const asRole = async <T>(role: string, run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      (await admin.begin(async (tx) => { await tx`SET LOCAL ROLE ${tx(role)}`; return run(tx); })) as T;
    const rdfRows = await asRole('usrp_rdf_officer', (tx) => tx`SELECT agency::text FROM public_core.venue_day_counts WHERE campaign_id = ${CAMPAIGN}`);
    const rnpRows = await asRole('usrp_rnp_officer', (tx) => tx`SELECT agency::text FROM public_core.venue_day_counts WHERE campaign_id = ${CAMPAIGN}`);
    check('the RDF officer role reads its venue row', rdfRows.length === 1);
    check('the RNP officer role sees none of it', rnpRows.length === 0);
    for (const role of ['usrp_rdf_officer', 'usrp_system_service', 'usrp_biometric_service', 'usrp_rdf_officer']) {
      let blocked = false;
      try { await asRole(role, (tx) => tx`UPDATE public_core.venue_day_counts SET admitted = 999 WHERE campaign_id = ${CAMPAIGN}`); }
      catch { blocked = true; }
      const unchanged = (await counts())?.admitted === 2;
      check(`${role} cannot write the projection`, blocked && unchanged);
    }

    console.log('\n── 9. GET /v1/venue-live-counts ──');
    const q = `campaign=${CAMPAIGN_CODE}&district=${DISTRICT}&examDate=${EXAM_DAY}`;
    const live = await call('GET', `/v1/venue-live-counts?${q}`, SUPERVISOR);
    const body = rec(live.json);
    const cs = rec(body['counts']);
    check('supervisor reads the counts', live.status === 200 && cs['expected'] === 1 && cs['admitted'] === 2 && cs['physicalCaptured'] === 2
      && cs['medicalRecorded'] === 1 && cs['openConflicts'] === 0, live.text);
    check('with an asOf instant', typeof body['asOf'] === 'string' && !Number.isNaN(Date.parse(String(body['asOf']))));
    check('counts only: no candidate, code or id on the wire',
      !/RDF-9|applicant|processingCode|nationalId|59000000-0000/i.test(live.text));
    check('agency administrator may read it too', (await call('GET', `/v1/venue-live-counts?${q}`, ADMIN_TOKEN)).status === 200);
    check('screening officer may read it (field.score.sync)', (await call('GET', `/v1/venue-live-counts?${q}`, SCREENING)).status === 200);
    check('a role with neither permission → 403', (await call('GET', `/v1/venue-live-counts?${q}`, token(['reviewer']))).status === 403);
    check('the sibling agency gets the bare 404', (await call('GET', `/v1/venue-live-counts?${q}`, RNP_SUPERVISOR)).status === 404);
    check('an unknown venue day → 404',
      (await call('GET', `/v1/venue-live-counts?campaign=${CAMPAIGN_CODE}&district=${OTHER_DISTRICT}&examDate=${EXAM_DAY}`, SUPERVISOR)).status === 404);
    check('missing parameters → 400', (await call('GET', '/v1/venue-live-counts', SUPERVISOR)).status === 400);
  } finally {
    await server.stop();
    await cleanup();
    await admin.end({ timeout: 5 });
  }

  if (failures > 0) {
    console.error(`\n${String(failures)} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\n✓ device fleet and venue live counts proven');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
