// ══════════════════════════════════════════════════════════════════
// application-service — Live single-record officer read self-check
//
// Proves the TWO reads the officer console's detail screen stands on:
//
//   GET /v1/applications/by-id?applicationId=          (officer, RLS-scoped)
//   GET /v1/applications/status-history?applicationId= (officer, RLS-scoped)
//
// Both were implemented and mounted with no gate over them. That is the
// hollow-gate shape ci-quality-gate.md exists to forbid, and these two routes
// are the worst place for it: a cross-agency read leak here produces a 200
// that looks exactly like a legitimate one in every log we keep.
//
// THE LOAD-BEARING ASSERTION IS NEGATIVE. by-id's 404 body is deliberately
// bare, so a sibling agency's REAL application id and a wholly NONEXISTENT id
// must be indistinguishable — byte-for-byte, not merely both-404. If those two
// responses ever diverge (a length, a code, a message), an officer can walk ids
// to enumerate what another agency is processing without ever seeing a record.
// Section 3 compares the raw response text for exactly that reason.
//
// Fixtures use the 8b… / 8c… prefixes so this check never collides with
// verify-auth-slice's 7a… / 7c… rows; the two can run in any order.
//
//   Run (repo root), with the live Tier-1 stack up + DB bootstrapped:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/application-service/selfcheck/verify-application-detail-reads.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import {
  createApplicationService,
  loadApplicationConfig,
  byIdRoute,
  statusHistoryRoute,
  BY_ID_PATH,
  STATUS_HISTORY_PATH,
} from '../src/index.js';

// ── In-test issuer key: set the verify public key BEFORE loading config ──
const AUTH_KEYS = generateDeviceKeyPair();
const OTHER_KEYS = generateDeviceKeyPair(); // a DIFFERENT issuer — must be rejected
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(AUTH_KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Fixtures: ONE applicant, ONE application per agency ─────────────
const APPLICANT_ID = '8b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';
const NID_HASH = 'b8b8b8b8'.repeat(8); // 64 hex — must never appear in a response
const RDF_CAMPAIGN = '8c111111-1111-4111-8111-111111111111';
const RNP_CAMPAIGN = '8c222222-2222-4222-8222-222222222222';
const RDF_APP = '8b111111-1111-4111-8111-111111111111';
const RNP_APP = '8b222222-2222-4222-8222-222222222222';
const RDF_CODE = 'RDF-96001';
const RNP_CODE = 'RNP-96001';
const ABSENT_APP = '8b999999-9999-4999-8999-999999999999'; // exists in no schema

// Seeded into rdf_ops.applications.qr_invitation_code. It is a BEARER
// credential scanned at the venue; if this string ever appears in a response
// body we have published an invitation token to every console session that can
// open the record. The omission is a security decision, so it gets a test.
const QR_SENTINEL = 'QR-SENTINEL-MUST-NOT-LEAK-8b111111';
const NESA_INDEX = '9601234567';
const OFFICER_ACTOR = '8b0f1cee-0000-4000-8000-00000000f1ce'; // performed_by on a human step
const CORRELATION = '8bcc0000-0000-4000-8000-0000000000cc';

// Two of these share performed_at on purpose (see section 6): the adapter
// orders by (performed_at, id), and the ids ascend in the causally correct
// order, so a lost tiebreak shows up as a scrambled legal record.
const H1 = '8b0a0001-0000-4000-8000-000000000001';
const H2 = '8b0a0002-0000-4000-8000-000000000002';
const H3 = '8b0a0003-0000-4000-8000-000000000003';
const H4 = '8b0a0004-0000-4000-8000-000000000004';
const H5 = '8b0a0005-0000-4000-8000-000000000005';
const TIED_AT = '2026-08-01T10:00:00.000Z'; // shared by H4 and H5

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

type Kind = 'officer' | 'system';
function mint(
  kind: Kind,
  opts: { agency?: 'RDF' | 'RNP' | 'RCS'; expiresAt?: string; key?: string } = {},
): string {
  const base = {
    v: 1 as const,
    iss: 'usrp',
    aud: 'usrp-services',
    sub: OFFICER_ACTOR,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: opts.expiresAt ?? '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer'
      ? { ...base, kind, agency: opts.agency ?? 'RDF', roles: [] }
      : { ...base, kind };
  return signAuthToken(opts.key ?? AUTH_KEYS.privateKeyPem, claims);
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    // rls/0007 makes the trail append-only by TRIGGER as well as by revoked
    // grant. Disabling replication triggers is the only way a fixture teardown
    // can remove its own history rows — and it is scoped to this transaction.
    await tx`SET LOCAL session_replication_role = replica`;
    for (const schema of ['rdf_ops', 'rnp_ops'] as const) {
      await tx`
        DELETE FROM ${tx(schema)}.application_status_history
        WHERE application_id IN (SELECT id FROM ${tx(schema)}.applications WHERE applicant_id = ${APPLICANT_ID})`;
      await tx`DELETE FROM ${tx(schema)}.applications WHERE applicant_id = ${APPLICANT_ID}`;
    }
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([RDF_CAMPAIGN, RNP_CAMPAIGN])}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
  });
}

async function seed(): Promise<void> {
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status)
    VALUES (${APPLICANT_ID}, ${NID_HASH}, 'x', 'x', 'x', 'x', 'MALE', 'WEB',
            'VERIFIED'::public_core.identity_verification_status)`;
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${RDF_CAMPAIGN}, 'Detail-read RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7),
      (${RNP_CAMPAIGN}, 'Detail-read RNP', 'RNP', 'REGISTRATION_OPEN', '["CADET_OFFICER"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;

  // The RDF row carries the QR bearer credential + a real academic value, so
  // section 2 can prove one is returned and the other is withheld.
  await admin`
    INSERT INTO rdf_ops.applications
      (id, processing_code, applicant_id, campaign_id, category, status,
       nesa_index_number, qr_invitation_code, submitted_at)
    VALUES (${RDF_APP}, ${RDF_CODE}, ${APPLICANT_ID}, ${RDF_CAMPAIGN},
            'GENERAL_ENLISTMENT',
            'PHYSICAL_TEST_SCHEDULED'::rdf_ops.application_status,
            ${NESA_INDEX}, ${QR_SENTINEL}, now() - interval '20 days')`;
  await admin`
    INSERT INTO rnp_ops.applications
      (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (${RNP_APP}, ${RNP_CODE}, ${APPLICANT_ID}, ${RNP_CAMPAIGN},
            'CADET_OFFICER', 'SUBMITTED'::rnp_ops.application_status)`;

  // The trail: SYSTEM steps, one HUMAN step (so actorKind has both values to
  // derive), and a tied-timestamp pair.
  await admin`
    INSERT INTO rdf_ops.application_status_history
      (id, application_id, from_status, to_status, reason, performed_by, performed_at, correlation_id)
    VALUES
      (${H1}, ${RDF_APP}, NULL, 'SUBMITTED', 'application filed',
       'SYSTEM', '2026-07-25T08:00:00.000Z', ${CORRELATION}),
      (${H2}, ${RDF_APP}, 'SUBMITTED', 'DOCUMENT_REVIEW_AMBER', 'forensics flagged the certificate',
       'SYSTEM', '2026-07-26T09:00:00.000Z', ${CORRELATION}),
      (${H3}, ${RDF_APP}, 'DOCUMENT_REVIEW_AMBER', 'DOCUMENT_REVIEW_GREEN', 'documents verified on review',
       ${OFFICER_ACTOR}, '2026-07-28T11:30:00.000Z', ${CORRELATION}),
      (${H4}, ${RDF_APP}, 'DOCUMENT_REVIEW_GREEN', 'SLOT_ASSIGNED', 'slot assigned',
       'SYSTEM', ${TIED_AT}, ${CORRELATION}),
      (${H5}, ${RDF_APP}, 'SLOT_ASSIGNED', 'PHYSICAL_TEST_SCHEDULED', 'invitation delivered',
       'SYSTEM', ${TIED_AT}, ${CORRELATION})`;
  await admin`
    INSERT INTO rnp_ops.application_status_history
      (application_id, from_status, to_status, reason, performed_by)
    VALUES (${RNP_APP}, NULL, 'SUBMITTED', 'application filed', 'SYSTEM')`;
}

async function main(): Promise<void> {
  const config = loadApplicationConfig();
  const bus = new InMemoryEventBus();
  const service = createApplicationService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  await cleanup();
  await seed();

  const server = await startHttpServer({
    serviceName: 'application-service-detail-reads-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [byIdRoute(service.list, verify), statusHistoryRoute(service.list, verify)],
    handleSignals: false,
  });
  const base = server.url;
  console.log(`\nServer listening at ${base}`);

  async function get(
    path: string,
    token?: string,
  ): Promise<{ status: number; text: string; json: unknown }> {
    const res = await fetch(`${base}${path}`, {
      method: 'GET',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  }
  const asRecord = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const byId = (id: string, token: string): Promise<{ status: number; text: string; json: unknown }> =>
    get(`${BY_ID_PATH}?applicationId=${id}`, token);
  const history = (id: string, token: string): Promise<{ status: number; text: string; json: unknown }> =>
    get(`${STATUS_HISTORY_PATH}?applicationId=${id}`, token);

  try {
    console.log('\n── 1. Nothing else returns ONE application: the officer read works ──');
    const rdf = await byId(RDF_APP, mint('officer', { agency: 'RDF' }));
    const rdfBody = asRecord(rdf.json);
    const detail = asRecord(rdfBody['application']);
    check('RDF officer by-id → 200', rdf.status === 200, `got ${rdf.status} ${rdf.text}`);
    check('body.agency == RDF (from the token, never the query)', rdfBody['agency'] === 'RDF', String(rdfBody['agency']));
    check('applicationId echoes the requested row', detail['applicationId'] === RDF_APP);
    check('processingCode returned', detail['processingCode'] === RDF_CODE, String(detail['processingCode']));
    check('status returned', detail['status'] === 'PHYSICAL_TEST_SCHEDULED', String(detail['status']));
    check('category returned', detail['category'] === 'GENERAL_ENLISTMENT', String(detail['category']));
    check('seeded academic value passes through', detail['nesaIndexNumber'] === NESA_INDEX, String(detail['nesaIndexNumber']));
    check(
      'createdAt/updatedAt are ISO strings, not raw Dates',
      typeof detail['createdAt'] === 'string' && !Number.isNaN(Date.parse(String(detail['createdAt']))) &&
        typeof detail['updatedAt'] === 'string' && !Number.isNaN(Date.parse(String(detail['updatedAt']))),
      `${String(detail['createdAt'])} / ${String(detail['updatedAt'])}`,
    );

    console.log('\n── 2. The two omissions are SECURITY decisions — so they get asserted ──');
    check('qr_invitation_code (a bearer credential) is NOT in the body', !rdf.text.includes(QR_SENTINEL));
    check('no qrInvitationCode key on the detail', !('qrInvitationCode' in detail));
    check('qrInvitationIssuedAt key IS present (the UI needs the timestamp)', 'qrInvitationIssuedAt' in detail);
    check('applicant_id is NOT in the body (the processing code stands in)', !rdf.text.includes(APPLICANT_ID));
    check('no applicantId key on the detail', !('applicantId' in detail));
    check('no national_id_hash anywhere in the body', !rdf.text.includes(NID_HASH));

    console.log('\n── 3. NO-ENUMERATION: sibling-agency id and absent id are INDISTINGUISHABLE ──');
    const rdfToken = mint('officer', { agency: 'RDF' });
    const sibling = await byId(RNP_APP, rdfToken); // a REAL row, wrong agency
    const absent = await byId(ABSENT_APP, rdfToken); // no such row anywhere
    check("RDF officer on RNP's real application → 404", sibling.status === 404, `got ${sibling.status} ${sibling.text}`);
    check('nonexistent application → 404', absent.status === 404, `got ${absent.status} ${absent.text}`);
    check(
      'by-id: the two 404 bodies are BYTE-IDENTICAL (no existence oracle)',
      sibling.text === absent.text,
      `sibling=${sibling.text} absent=${absent.text}`,
    );
    check("sibling 404 does not leak RNP's processing code", !sibling.text.includes(RNP_CODE));
    const hSibling = await history(RNP_APP, rdfToken);
    const hAbsent = await history(ABSENT_APP, rdfToken);
    check('status-history on a sibling id → 404', hSibling.status === 404, `got ${hSibling.status}`);
    check('status-history on an absent id → 404', hAbsent.status === 404, `got ${hAbsent.status}`);
    check(
      'status-history: the two 404 bodies are BYTE-IDENTICAL',
      hSibling.text === hAbsent.text,
      `sibling=${hSibling.text} absent=${hAbsent.text}`,
    );
    // The existence probe is the whole reason a sibling id is not an empty
    // timeline. An empty array here would render as a blank-but-valid history
    // for a record the officer must not know exists.
    check(
      "sibling id is NEVER an empty history (404, not '[]')",
      !hSibling.text.includes('"history"'),
      hSibling.text,
    );
    // And the 404 is not the route being broken: the OWNER can read it.
    const rnpOwn = await byId(RNP_APP, mint('officer', { agency: 'RNP' }));
    check('RNP officer CAN read the same row → 200 (the 404 was scoping, not a bug)', rnpOwn.status === 200, `got ${rnpOwn.status} ${rnpOwn.text}`);
    check('RNP body is agency-stamped RNP', asRecord(rnpOwn.json)['agency'] === 'RNP');

    console.log('\n── 4. Cross-agency isolation is ALSO enforced by the DB role ──');
    // Belt and braces: even if the query were mis-routed, the officer role has
    // no grant on a sibling ops schema.
    let denied = false;
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql('usrp_rdf_officer')}`;
        await tx`SELECT id FROM rnp_ops.application_status_history LIMIT 1`;
      });
    } catch {
      denied = true;
    }
    check('usrp_rdf_officer denied reading rnp_ops.application_status_history', denied);

    console.log('\n── 5. The Procedural Justice surface: who changed what, when, why ──');
    const trail = await history(RDF_APP, rdfToken);
    const trailBody = asRecord(trail.json);
    const entries = Array.isArray(trailBody['history']) ? (trailBody['history'] as unknown[]) : [];
    check('RDF officer status-history → 200', trail.status === 200, `got ${trail.status} ${trail.text}`);
    check('applicationId echoed', trailBody['applicationId'] === RDF_APP);
    check('all 5 seeded entries returned', entries.length === 5, String(entries.length));
    const first = asRecord(entries[0]);
    check('oldest first: entry 0 is the null → SUBMITTED opener', first['fromStatus'] === null && first['toStatus'] === 'SUBMITTED', JSON.stringify(first));
    check('timestamps are non-decreasing', entries.every((e, i) => i === 0 || Date.parse(String(asRecord(entries[i - 1])['at'])) <= Date.parse(String(asRecord(e)['at']))));
    check('every entry carries actor + at + toStatus', entries.every((e) => {
      const r = asRecord(e);
      return typeof r['actor'] === 'string' && typeof r['at'] === 'string' && typeof r['toStatus'] === 'string';
    }));
    check('the note (reason) is carried', first['note'] === 'application filed', String(first['note']));
    check('correlationId is carried (stitches to the Kafka trace)', first['correlationId'] === CORRELATION, String(first['correlationId']));
    const human = entries.map(asRecord).find((r) => r['toStatus'] === 'DOCUMENT_REVIEW_GREEN');
    check("actorKind derived 'OFFICER' for the human review step", human?.['actorKind'] === 'OFFICER', String(human?.['actorKind']));
    check('that step names the officer who decided', human?.['actor'] === OFFICER_ACTOR, String(human?.['actor']));
    check("actorKind derived 'SYSTEM' for the automated opener", first['actorKind'] === 'SYSTEM', String(first['actorKind']));
    check(
      "no entry is mislabelled: 'SYSTEM' actor ⇔ SYSTEM kind",
      entries.map(asRecord).every((r) => (r['actor'] === 'SYSTEM') === (r['actorKind'] === 'SYSTEM')),
    );
    check('the trail leaks no PII', !trail.text.includes(NID_HASH) && !trail.text.includes(APPLICANT_ID));

    console.log('\n── 6. Tied timestamps keep a STABLE order (a legal record cannot shuffle) ──');
    const tied = entries.map(asRecord).filter((r) => Date.parse(String(r['at'])) === Date.parse(TIED_AT));
    check('both tied-timestamp entries came back', tied.length === 2, String(tied.length));
    check(
      'the (performed_at, id) tiebreak keeps the causal chain: SLOT_ASSIGNED then PHYSICAL_TEST_SCHEDULED',
      tied[0]?.['toStatus'] === 'SLOT_ASSIGNED' && tied[1]?.['toStatus'] === 'PHYSICAL_TEST_SCHEDULED',
      tied.map((r) => String(r['toStatus'])).join('→'),
    );
    check(
      "each entry's fromStatus matches the previous toStatus (unbroken chain)",
      entries.map(asRecord).every((r, i) => i === 0 || r['fromStatus'] === asRecord(entries[i - 1])['toStatus']),
      entries.map((e) => `${String(asRecord(e)['fromStatus'])}→${String(asRecord(e)['toStatus'])}`).join(' | '),
    );
    // Unstable sorts hide behind a single request. Ask again and compare.
    const trailAgain = await history(RDF_APP, rdfToken);
    check('repeated request returns the IDENTICAL ordering', trailAgain.text === trail.text);

    console.log('\n── 7. A malformed id is a 400, never a 500 at the uuid column ──');
    for (const [label, value] of [
      ['not-a-uuid', 'nope'],
      ['empty', ''],
      ["SQL-ish ' OR 1=1", "' OR 1=1"],
    ] as const) {
      const bad = await byId(encodeURIComponent(value), rdfToken);
      check(`by-id ${label} → 400`, bad.status === 400, `got ${bad.status} ${bad.text}`);
      check(`by-id ${label} carries INVALID_APPLICATION_ID`, bad.text.includes('INVALID_APPLICATION_ID'), bad.text);
      const badHist = await history(encodeURIComponent(value), rdfToken);
      check(`status-history ${label} → 400`, badHist.status === 400, `got ${badHist.status} ${badHist.text}`);
    }
    check('by-id with NO applicationId param → 400', (await get(BY_ID_PATH, rdfToken)).status === 400);
    check('status-history with NO applicationId param → 400', (await get(STATUS_HISTORY_PATH, rdfToken)).status === 400);

    console.log('\n── 8. Both routes are OFFICER-only: 401 unauthenticated, 403 wrong kind ──');
    for (const [label, path] of [['by-id', BY_ID_PATH], ['status-history', STATUS_HISTORY_PATH]] as const) {
      const q = `${path}?applicationId=${RDF_APP}`;
      check(`${label}: no token → 401`, (await get(q)).status === 401);
      check(`${label}: garbage token → 401`, (await get(q, 'not.a.valid.token')).status === 401);
      check(
        `${label}: expired token → 401`,
        (await get(q, mint('officer', { agency: 'RDF', expiresAt: '2020-01-01T00:00:00.000Z' }))).status === 401,
      );
      check(
        `${label}: wrong-issuer-key token → 401`,
        (await get(q, mint('officer', { agency: 'RDF', key: OTHER_KEYS.privateKeyPem }))).status === 401,
      );
      // A system token is the applicant portal's credential. It reads
      // cross-agency by design on by-applicant; it must NOT reach an
      // officer-scoped route, or the citizen door widens into an officer view.
      const sys = await get(q, mint('system'));
      check(`${label}: system token → 403`, sys.status === 403, `got ${sys.status} ${sys.text}`);
      check(`${label}: the 403 body leaks no record data`, !sys.text.includes(RDF_CODE));
    }
  } finally {
    await cleanup();
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('SINGLE-RECORD OFFICER READS PROVEN (live) ✓');
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
