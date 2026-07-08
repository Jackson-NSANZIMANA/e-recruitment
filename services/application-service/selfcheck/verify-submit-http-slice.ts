// ══════════════════════════════════════════════════════════════════
// application-service — Live HTTP-transport self-check (the front door)
//
// Boots the real service over @usrp/shared-http on an ephemeral port and
// drives it through an actual TCP socket with fetch — proving the front
// door end-to-end against live infrastructure (PostgreSQL as usrp_app,
// writing into the RDF ops schema as usrp_system_service; InMemoryEventBus
// so we can inspect the emitted APPLICANT_SUBMITTED and correlation
// propagation). Repeatable: seeds its own VERIFIED + PENDING applicants and
// an open RDF campaign, and cleans every row it touches before and after.
// Exits non-zero on the first failed assertion.
//
//   Run (repo root), with the live Tier-1 stack up:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   pnpm --filter @usrp/application-service selfcheck
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import {
  createApplicationService,
  loadApplicationConfig,
  submitApplicationRoute,
  SUBMIT_APPLICATION_PATH,
} from '../src/index.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// Deterministic fixtures — recognizable, so a stray row is obvious.
const VERIFIED_ID = '22222222-2222-4222-8222-222222222222';
const PENDING_ID = '33333333-3333-4333-8333-333333333333';
const MISSING_ID = '44444444-4444-4444-8444-444444444444'; // never seeded
const CAMPAIGN_ID = '55555555-5555-4555-8555-555555555555';       // RDF, open
const RNP_CAMPAIGN_ID = '66666666-6666-4666-8666-666666666666';   // RNP, open
const NID_HASH = 'deadbeef'.repeat(8); // 64 hex chars — the VERIFIED applicant's key
const PENDING_NID_HASH = 'feedface'.repeat(8); // distinct — the hash column is UNIQUE
const NESA_INDEX = 'RW2024SC00123';
const HEC_REG = 'HEC-2024-000789';
const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function cleanup(): Promise<void> {
  // application_status_history is append-only (0007 trigger binds every role),
  // so teardown deletes run inside the documented superuser escape hatch —
  // triggers (immutability + FK) disabled for this maintenance tx only, which
  // also frees delete order. Both agency schemas the proof writes (rdf + rnp).
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    const ids = tx([VERIFIED_ID, PENDING_ID]);
    for (const schema of ['rdf_ops', 'rnp_ops'] as const) {
      await tx`
        DELETE FROM ${tx(schema)}.application_status_history
        WHERE application_id IN (
          SELECT id FROM ${tx(schema)}.applications WHERE applicant_id IN ${ids}
        )`;
      await tx`DELETE FROM ${tx(schema)}.applications WHERE applicant_id IN ${ids}`;
    }
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([CAMPAIGN_ID, RNP_CAMPAIGN_ID])}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${ids}`;
  });
}

async function seed(): Promise<void> {
  // Two applicants: one VERIFIED (accepts submissions), one PENDING (rejected).
  // encrypted_* are never read by the front door, so opaque placeholders suffice.
  for (const [id, hash, status] of [
    [VERIFIED_ID, NID_HASH, 'VERIFIED'],
    [PENDING_ID, PENDING_NID_HASH, 'PENDING'],
  ] as const) {
    await admin`
      INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, gender,
         registration_channel, identity_status)
      VALUES (${id}, ${hash}, 'x', 'x', 'x', 'x', 'MALE', 'WEB', ${status}::public_core.identity_verification_status)`;
  }
  // Two open campaigns: RDF accepting GENERAL_ENLISTMENT (and only that),
  // RNP accepting CADET_OFFICER — so the proof can show a submission routing
  // to the OWNING agency's isolated ops schema, per category.
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${CAMPAIGN_ID}, 'Self-check RDF Intake', 'RDF',
       'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days',
       '2026-09-01', '2026-09-15', 7),
      (${RNP_CAMPAIGN_ID}, 'Self-check RNP Intake', 'RNP',
       'REGISTRATION_OPEN', '["CADET_OFFICER"]',
       now() - interval '1 day', now() + interval '30 days',
       '2026-09-01', '2026-09-15', 7)`;
}

async function main(): Promise<void> {
  const config = loadApplicationConfig();
  const bus = new InMemoryEventBus();
  const service = createApplicationService(config, bus);

  await cleanup();
  await seed();

  const server = await startHttpServer({
    serviceName: 'application-service-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [submitApplicationRoute(service.submit)],
    readiness: async (): Promise<boolean> => {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    handleSignals: false,
  });
  const base = server.url;
  console.log(`\nServer listening at ${base}`);

  const bodies: string[] = [];
  async function call(
    method: string,
    path: string,
    init?: { readonly headers?: Record<string, string>; readonly body?: string },
  ): Promise<{ status: number; text: string; json: unknown; headers: Headers }> {
    const res = await fetch(`${base}${path}`, {
      method,
      ...(init?.headers ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    const text = await res.text();
    bodies.push(text);
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, headers: res.headers };
  }

  const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };
  const asRecord = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

  try {
    console.log('\n── 1. POST verified applicant → 201 SUBMITTED ────────────────');
    const r1 = await call('POST', SUBMIT_APPLICATION_PATH, {
      headers: { ...JSON_HEADERS, 'x-correlation-id': CORRELATION_ID },
      body: JSON.stringify({
        applicantId: VERIFIED_ID,
        category: 'GENERAL_ENLISTMENT',
        channel: 'WEB',
        nesaIndexNumber: NESA_INDEX,
      }),
    });
    const b1 = asRecord(r1.json);
    check('status is 201', r1.status === 201, `got ${r1.status} ${r1.text}`);
    check('body.status is SUBMITTED', b1['status'] === 'SUBMITTED', String(b1['status']));
    const applicationId = typeof b1['applicationId'] === 'string' ? b1['applicationId'] : '';
    check('applicationId is a UUID', /^[0-9a-f-]{36}$/.test(applicationId), applicationId);
    const processingCode = typeof b1['processingCode'] === 'string' ? b1['processingCode'] : '';
    check('processingCode matches RDF-NNNNN', /^RDF-\d{5}$/.test(processingCode), processingCode);
    check('body.agency is RDF', b1['agency'] === 'RDF', String(b1['agency']));
    check('response echoes x-correlation-id', r1.headers.get('x-correlation-id') === CORRELATION_ID);
    check('body does NOT expose nationalIdHash', !('nationalIdHash' in b1) && !r1.text.includes(NID_HASH));

    console.log('\n── 2. APPLICANT_SUBMITTED published, envelope + payload ──────');
    check('exactly one event published', bus.published.length === 1, `got ${bus.published.length}`);
    const ev = asRecord(bus.published[0]);
    check('eventType is APPLICANT_SUBMITTED', ev['eventType'] === 'APPLICANT_SUBMITTED', String(ev['eventType']));
    check('event.correlationId == inbound', ev['correlationId'] === CORRELATION_ID, String(ev['correlationId']));
    check('event.applicantId == verified id', ev['applicantId'] === VERIFIED_ID);
    check('event.applicationId == created application', ev['applicationId'] === applicationId, String(ev['applicationId']));
    check('event.nationalIdHash == seeded hash', ev['nationalIdHash'] === NID_HASH);
    check('event.agency == RDF', ev['agency'] === 'RDF');
    check('event.category == GENERAL_ENLISTMENT', ev['category'] === 'GENERAL_ENLISTMENT');
    check('event.channel == WEB', ev['channel'] === 'WEB');
    check('event.nesaIndexNumber == provided', ev['nesaIndexNumber'] === NESA_INDEX);
    check('event.hecRegistrationNumber is null', ev['hecRegistrationNumber'] === null);

    console.log('\n── 3. Persisted state in rdf_ops (application + history) ─────');
    const appRows = await admin<{ status: string; campaign_id: string; nesa_index_number: string | null; processing_code: string }[]>`
      SELECT status::text, campaign_id, nesa_index_number, processing_code
      FROM rdf_ops.applications WHERE id = ${applicationId}`;
    const app = appRows[0];
    check('application row exists', app !== undefined);
    check('application.status == SUBMITTED', app?.status === 'SUBMITTED', String(app?.status));
    check('application.campaign_id == resolved campaign', app?.campaign_id === CAMPAIGN_ID, String(app?.campaign_id));
    check('application.nesa_index_number persisted', app?.nesa_index_number === NESA_INDEX, String(app?.nesa_index_number));
    check('application.processing_code matches response', app?.processing_code === processingCode);
    const histRows = await admin<{ from_status: string | null; to_status: string; performed_by: string; correlation_id: string | null }[]>`
      SELECT from_status::text, to_status::text, performed_by, correlation_id
      FROM rdf_ops.application_status_history WHERE application_id = ${applicationId}`;
    check('exactly one history row', histRows.length === 1, `got ${histRows.length}`);
    const h = histRows[0];
    check('history from_status is NULL', h?.from_status === null);
    check('history to_status is SUBMITTED', h?.to_status === 'SUBMITTED', String(h?.to_status));
    check('history performed_by is SYSTEM', h?.performed_by === 'SYSTEM', String(h?.performed_by));
    check('history correlation_id == inbound', h?.correlation_id === CORRELATION_ID, String(h?.correlation_id));

    console.log('\n── 3b. Cross-agency routing → OWNING schema only (RNP) ───────');
    // An RNP category (HEC path) must land in rnp_ops, mint an RNP code, and
    // NOT appear in rdf_ops — the isolated-schema guarantee, per category.
    const rRnp = await call('POST', SUBMIT_APPLICATION_PATH, {
      headers: JSON_HEADERS,
      body: JSON.stringify({
        applicantId: VERIFIED_ID,
        category: 'CADET_OFFICER',
        channel: 'IREMBO_KIOSK',
        hecRegistrationNumber: HEC_REG,
      }),
    });
    const bRnp = asRecord(rRnp.json);
    check('RNP submit → 201', rRnp.status === 201, `got ${rRnp.status} ${rRnp.text}`);
    check('processingCode matches RNP-NNNNN', /^RNP-\d{5}$/.test(String(bRnp['processingCode'])), String(bRnp['processingCode']));
    check('body.agency is RNP', bRnp['agency'] === 'RNP', String(bRnp['agency']));
    const rnpAppId = typeof bRnp['applicationId'] === 'string' ? bRnp['applicationId'] : '';
    const evRnp = asRecord(bus.published[1]);
    check('2nd event published (RNP)', bus.published.length === 2, `got ${bus.published.length}`);
    check('RNP event.agency == RNP', evRnp['agency'] === 'RNP');
    check('RNP event.hecRegistrationNumber == provided', evRnp['hecRegistrationNumber'] === HEC_REG);
    check('RNP event.nesaIndexNumber is null (HEC path)', evRnp['nesaIndexNumber'] === null);
    const inRnp = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM rnp_ops.applications WHERE id = ${rnpAppId}`;
    check('application row is in rnp_ops', inRnp[0]?.n === 1, String(inRnp[0]?.n));
    const inRdf = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM rdf_ops.applications WHERE id = ${rnpAppId}`;
    check('application row is NOT in rdf_ops (isolation)', inRdf[0]?.n === 0, String(inRdf[0]?.n));

    console.log('\n── 4. Business rejections (return-value outcomes) ────────────');
    const notFound = await call('POST', SUBMIT_APPLICATION_PATH, {
      headers: JSON_HEADERS,
      body: JSON.stringify({ applicantId: MISSING_ID, category: 'GENERAL_ENLISTMENT', channel: 'WEB', nesaIndexNumber: NESA_INDEX }),
    });
    check('unknown applicant → 404 APPLICANT_NOT_FOUND', notFound.status === 404 && asRecord(notFound.json)['status'] === 'APPLICANT_NOT_FOUND', `${notFound.status} ${notFound.text}`);

    const notVerified = await call('POST', SUBMIT_APPLICATION_PATH, {
      headers: JSON_HEADERS,
      body: JSON.stringify({ applicantId: PENDING_ID, category: 'GENERAL_ENLISTMENT', channel: 'WEB', nesaIndexNumber: NESA_INDEX }),
    });
    check('PENDING identity → 409 IDENTITY_NOT_VERIFIED', notVerified.status === 409 && asRecord(notVerified.json)['status'] === 'IDENTITY_NOT_VERIFIED', `${notVerified.status} ${notVerified.text}`);

    const badAcademic = await call('POST', SUBMIT_APPLICATION_PATH, {
      headers: JSON_HEADERS,
      body: JSON.stringify({ applicantId: VERIFIED_ID, category: 'GENERAL_ENLISTMENT', channel: 'WEB' }), // NESA path, no index
    });
    check('missing NESA index → 422 INVALID_ACADEMIC_INPUT', badAcademic.status === 422 && asRecord(badAcademic.json)['status'] === 'INVALID_ACADEMIC_INPUT', `${badAcademic.status} ${badAcademic.text}`);

    const noCampaign = await call('POST', SUBMIT_APPLICATION_PATH, {
      headers: JSON_HEADERS,
      body: JSON.stringify({ applicantId: VERIFIED_ID, category: 'RESERVE_FORCE_ALEVEL', channel: 'WEB', nesaIndexNumber: NESA_INDEX }),
    });
    check('no open campaign for category → 409 NO_OPEN_CAMPAIGN', noCampaign.status === 409 && asRecord(noCampaign.json)['status'] === 'NO_OPEN_CAMPAIGN', `${noCampaign.status} ${noCampaign.text}`);
    check('NO_OPEN_CAMPAIGN reports agency RDF', asRecord(noCampaign.json)['agency'] === 'RDF');

    check('no further events from rejected submissions', bus.published.length === 2, `got ${bus.published.length}`);

    console.log('\n── 5. Input validation → 400 ────────────────────────────────');
    const noId = await call('POST', SUBMIT_APPLICATION_PATH, { headers: JSON_HEADERS, body: JSON.stringify({ category: 'GENERAL_ENLISTMENT', channel: 'WEB' }) });
    check('missing applicantId → 400 MISSING_APPLICANT_ID', noId.status === 400 && asRecord(noId.json)['error'] === 'MISSING_APPLICANT_ID', `${noId.status} ${noId.text}`);
    // Malformed (non-UUID) id must be a 400 at the edge — never a 5xx from the
    // uuid-typed column downstream (regression guard for that exact leak).
    const badId = await call('POST', SUBMIT_APPLICATION_PATH, { headers: JSON_HEADERS, body: JSON.stringify({ applicantId: 'not-a-uuid', category: 'GENERAL_ENLISTMENT', channel: 'WEB', nesaIndexNumber: NESA_INDEX }) });
    check('malformed applicantId → 400 INVALID_APPLICANT_ID', badId.status === 400 && asRecord(badId.json)['error'] === 'INVALID_APPLICANT_ID', `${badId.status} ${badId.text}`);
    const badCat = await call('POST', SUBMIT_APPLICATION_PATH, { headers: JSON_HEADERS, body: JSON.stringify({ applicantId: VERIFIED_ID, category: 'ASTRONAUT', channel: 'WEB' }) });
    check('invalid category → 400 INVALID_CATEGORY', badCat.status === 400 && asRecord(badCat.json)['error'] === 'INVALID_CATEGORY', `${badCat.status} ${badCat.text}`);
    const badChannel = await call('POST', SUBMIT_APPLICATION_PATH, { headers: JSON_HEADERS, body: JSON.stringify({ applicantId: VERIFIED_ID, category: 'GENERAL_ENLISTMENT', channel: 'CARRIER_PIGEON' }) });
    check('invalid channel → 400 INVALID_CHANNEL', badChannel.status === 400 && asRecord(badChannel.json)['error'] === 'INVALID_CHANNEL', `${badChannel.status} ${badChannel.text}`);

    console.log('\n── 6. Health, readiness, routing ────────────────────────────');
    const health = await call('GET', '/health');
    check('GET /health → 200 ok', health.status === 200 && asRecord(health.json)['status'] === 'ok');
    const ready = await call('GET', '/ready');
    check('GET /ready → 200 ready (DB reachable)', ready.status === 200 && asRecord(ready.json)['status'] === 'ready', `${ready.status} ${ready.text}`);
    const wrongMethod = await call('GET', SUBMIT_APPLICATION_PATH);
    check('GET on submit path → 405', wrongMethod.status === 405, `got ${wrongMethod.status}`);

    console.log('\n── 7. The national_id_hash never leaks to the client ─────────');
    const allBodies = bodies.join('\n');
    check('national_id_hash absent from every HTTP response body', !allBodies.includes(NID_HASH));
  } finally {
    await cleanup();
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('ALL APPLICATION FRONT-DOOR ASSERTIONS PASSED ✓');
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
