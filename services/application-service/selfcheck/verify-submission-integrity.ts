// ══════════════════════════════════════════════════════════════════
// application-service — SUBMISSION INTEGRITY self-check (ADR-027, live)
//
// The front door's counterpart to scheduling's slot-integrity proof. ADR-025
// made the citizen's retry SAFE TO SEND (the event can no longer be lost);
// this proves it is now SAFE TO RECEIVE — a retried POST replays instead of
// filing a second application, and one citizen cannot hold two live
// applications for the same campaign and category by any route.
//
//   0. COMPLETENESS — every artefact in front-door.manifest.json exists and
//      still contains the symbol that makes it load-bearing. Zero infra, runs
//      first: this is the check that would have caught the slice shipping as
//      its SQL migration alone.
//   1. CANONICAL HASH — deterministic, key-order independent, null ≠ "", and
//      no two different requests can collide through a delimiter.
//   2. ENGINE — the three live-intent partial unique indexes exist with the
//      EXACT predicate, and the ledger is append-only under FORCE'd RLS.
//   3. HTTP — first submit 201; identical retry 201 + Idempotency-Replayed,
//      same ids, nothing written; same key + different body 409 KEY_REUSED;
//      different key + live duplicate 409 ALREADY_APPLIED; bad key 400.
//   4. ATOMICITY — exactly one application, one history row, one ledger row
//      and ONE APPLICANT_SUBMITTED survive the whole sequence.
//   5. CONCURRENCY — 8 parallel identical retries file exactly one
//      application; 8 parallel DIFFERENT keys also file exactly one.
//   6. WALK-IN — the on-site lane answers the duplicate instead of faulting,
//      and a citizen who applied online cannot be registered again at the
//      venue.
//   7. WITHDRAWAL — the predicate is honoured: a withdrawn application frees
//      the intent, so the citizen may genuinely re-apply.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/application-service/selfcheck/verify-submission-integrity.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';

// ── In-test issuer key: set the verify key BEFORE loading config ──
const AUTH_KEYS = generateDeviceKeyPair();
const PUBLIC_PEM = createPublicKey(AUTH_KEYS.publicKeyPem)
  .export({ type: 'spki', format: 'pem' })
  .toString();
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(PUBLIC_PEM, 'utf8').toString('base64');

const {
  canonicalRequestHash,
  createApplicationService,
  loadApplicationConfig,
  submitApplicationRoute,
  walkInRoutes,
  SUBMIT_APPLICATION_PATH,
  WALK_IN_REGISTER_PATH,
} = await import('../src/index.js');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANIFEST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'front-door.manifest.json',
);

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Deterministic fixtures (9xxx namespace — recognisably this proof's) ──
const DIGITAL_APPLICANT = '99000000-0000-4000-8000-000000000001';
const KEYLESS_APPLICANT = '99000000-0000-4000-8000-000000000002';
const RACE_SAME_KEY_APPLICANT = '99000000-0000-4000-8000-000000000003';
const RACE_DIFF_KEY_APPLICANT = '99000000-0000-4000-8000-000000000004';
const WALK_IN_APPLICANT = '99000000-0000-4000-8000-000000000005';
const ONLINE_THEN_WALKIN_APPLICANT = '99000000-0000-4000-8000-000000000006';
const WITHDRAWN_APPLICANT = '99000000-0000-4000-8000-000000000007';
const ALL_APPLICANTS = [
  DIGITAL_APPLICANT,
  KEYLESS_APPLICANT,
  RACE_SAME_KEY_APPLICANT,
  RACE_DIFF_KEY_APPLICANT,
  WALK_IN_APPLICANT,
  ONLINE_THEN_WALKIN_APPLICANT,
  WITHDRAWN_APPLICANT,
];

// ONE campaign serving BOTH lanes, deliberately. The live-intent index keys
// on (applicant_id, campaign_id, category), so a cross-lane duplicate is only
// a duplicate within the SAME campaign — proving it needs a campaign that
// satisfies findOpenCampaign (REGISTRATION_OPEN, registration window live)
// AND findWalkInCampaign (allows_walk_in, examination window covers today)
// at once. That overlap is legitimate: ADR-012 allows a campaign still open
// for registration whose exam window has started.
const CAMPAIGN = '99000000-0000-4000-8000-0000000000c1';
const RDF_OFFICER_ID = '99000000-0000-4000-8000-00000000ff01';
const CATEGORY = 'GENERAL_ENLISTMENT';
const NESA = 'RW2024SC09001';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function mint(kind: 'officer' | 'system', sub: string, agency: 'RDF' | 'RNP' = 'RDF'): string {
  const base = {
    v: 1 as const,
    iss: 'usrp',
    aud: 'usrp-services',
    sub,
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
  const claims: AuthTokenClaims =
    kind === 'officer' ? { ...base, kind, agency, roles: [] } : { ...base, kind };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    // Status history and the ledger are append-only for every role; the
    // documented superuser escape hatch disables triggers for this
    // maintenance transaction only.
    await tx`SET LOCAL session_replication_role = replica`;
    const ids = tx(ALL_APPLICANTS);
    for (const schema of ['rdf_ops', 'rnp_ops'] as const) {
      const apps = await tx<{ id: string }[]>`
        SELECT id FROM ${tx(schema)}.applications WHERE applicant_id IN ${ids}`;
      if (apps.length > 0) {
        const appIds = tx(apps.map((a) => a.id));
        await tx`DELETE FROM public_core.event_outbox
                 WHERE payload->>'applicationId' IN ${appIds}
                    OR payload->>'entityId' IN ${appIds}`;
        await tx`DELETE FROM ${tx(schema)}.application_status_history
                 WHERE application_id IN ${appIds}`;
        await tx`DELETE FROM ${tx(schema)}.applications WHERE id IN ${appIds}`;
      }
    }
    await tx`DELETE FROM public_core.event_outbox WHERE payload->>'applicantId' IN ${ids}`;
    await tx`DELETE FROM public_core.submission_requests WHERE applicant_id IN ${ids}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${ids}`;
  });
}

async function seed(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await admin.begin(async (tx) => {
    for (const [i, id] of ALL_APPLICANTS.entries()) {
      // national_id_hash is UNIQUE — one distinct 64-hex value per applicant.
      const hash = `99${String(i).padStart(2, '0')}`.repeat(16).slice(0, 64);
      await tx`
        INSERT INTO public_core.applicant_identities
          (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
           encrypted_home_district, encrypted_home_province, gender,
           registration_channel, identity_status)
        VALUES (${id}, ${hash}, 'enc','enc','enc','enc','MALE','WEB','VERIFIED')`;
    }
    await tx`
      INSERT INTO public_core.recruitment_campaigns
        (id, campaign_label, agency, status, target_categories, registration_opens_at,
         registration_closes_at, examination_start_date, examination_end_date,
         examination_reporting_hour, allows_walk_in)
      VALUES
        (${CAMPAIGN}, 'SUBMISSION-INTEGRITY', 'RDF', 'REGISTRATION_OPEN',
         '["GENERAL_ENLISTMENT"]', now() - interval '1 day', now() + interval '30 days',
         ${today}, ${today}, 7, true)`;
  });
}

async function countApplications(applicantId: string): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rdf_ops.applications WHERE applicant_id = ${applicantId}`;
  return rows[0]?.n ?? -1;
}

async function countLedger(applicantId: string): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public_core.submission_requests
    WHERE applicant_id = ${applicantId}`;
  return rows[0]?.n ?? -1;
}

async function countSubmittedEvents(applicantId: string): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public_core.event_outbox
    WHERE event_type = 'APPLICANT_SUBMITTED' AND payload->>'applicantId' = ${applicantId}`;
  return rows[0]?.n ?? -1;
}

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly text: string;
  readonly replayed: string | null;
}

async function main(): Promise<void> {
  // ════════════════════════════════════════════════════════════════
  console.log('\n── 0. Front-door completeness manifest ──────────────────────');
  // The slice's own anti-regression: a future change that deletes the ledger
  // adapter, unwires it, or drops the proof from the gate turns this red
  // before any infrastructure is even touched.
  interface Artefact {
    readonly id: string;
    readonly path: string;
    readonly mustContain: readonly string[];
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    readonly artefacts: readonly Artefact[];
  };
  check('manifest declares artefacts', manifest.artefacts.length > 0);
  for (const artefact of manifest.artefacts) {
    let content: string | null = null;
    try {
      content = readFileSync(join(REPO_ROOT, artefact.path), 'utf8');
    } catch {
      content = null;
    }
    if (content === null) {
      check(`${artefact.id}: ${artefact.path} exists`, false, 'file is missing');
      continue;
    }
    const missing = artefact.mustContain.filter((needle) => !content.includes(needle));
    check(
      `${artefact.id}: ${artefact.path}`,
      missing.length === 0,
      missing.length > 0 ? `no longer contains ${missing.join(', ')}` : '',
    );
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n── 1. Canonical request hash ────────────────────────────────');
  const baseReq = {
    applicantId: DIGITAL_APPLICANT,
    category: CATEGORY,
    channel: 'WEB',
    nesaIndexNumber: NESA,
    hecRegistrationNumber: null,
  } as const;
  const h = canonicalRequestHash(baseReq);
  check('hash is 64 hex chars (sha-256)', /^[0-9a-f]{64}$/.test(h), h);
  check('hash is deterministic', canonicalRequestHash({ ...baseReq }) === h);
  // Key ORDER must not matter: a client that serialises its retry differently
  // is still sending the same request.
  check(
    'hash is independent of object key order',
    canonicalRequestHash({
      hecRegistrationNumber: null,
      nesaIndexNumber: NESA,
      channel: 'WEB',
      category: CATEGORY,
      applicantId: DIGITAL_APPLICANT,
    }) === h,
  );
  check(
    'a different channel changes the hash',
    canonicalRequestHash({ ...baseReq, channel: 'USSD' }) !== h,
  );
  check(
    'a different academic credential changes the hash',
    canonicalRequestHash({ ...baseReq, nesaIndexNumber: 'RW2024SC09999' }) !== h,
  );
  check(
    'null and empty string are distinct',
    canonicalRequestHash({ ...baseReq, hecRegistrationNumber: '' }) !== h,
  );
  // The length-prefix test: with a plain delimiter these two DIFFERENT
  // requests would serialise identically and look like a replay of each other.
  check(
    'delimiter-bearing values cannot collide (length-prefixed encoding)',
    canonicalRequestHash({ ...baseReq, nesaIndexNumber: 'A|B', hecRegistrationNumber: null }) !==
      canonicalRequestHash({ ...baseReq, nesaIndexNumber: 'A', hecRegistrationNumber: 'B' }),
  );

  await cleanup();
  await seed();

  // ════════════════════════════════════════════════════════════════
  console.log('\n── 2. The engine enforces it (live schema) ──────────────────');
  const idxRows = await admin<{ schema: string; name: string; def: string }[]>`
    SELECT schemaname AS schema, indexname AS name, indexdef AS def
    FROM pg_indexes
    WHERE indexname LIKE 'uq\\_%\\_applications\\_live\\_intent'
    ORDER BY schemaname`;
  check('all three live-intent indexes exist', idxRows.length === 3, `found ${idxRows.length}`);
  for (const agency of ['rdf', 'rnp', 'rcs'] as const) {
    const row = idxRows.find((r) => r.name === `uq_${agency}_applications_live_intent`);
    check(`uq_${agency}_applications_live_intent exists`, row !== undefined);
    if (row === undefined) continue;
    const def = row.def.replace(/\s+/g, ' ');
    check(`  …is UNIQUE`, def.includes('CREATE UNIQUE INDEX'), def);
    check(
      `  …keys (applicant_id, campaign_id, category)`,
      /\(applicant_id,\s*campaign_id,\s*category\)/.test(def),
      def,
    );
    // The predicate is the whole policy: a WITHDRAWN application must not
    // block a genuine re-application (owner decision D1).
    check(
      `  …is partial on status <> 'WITHDRAWN'`,
      /WHERE \(status <> 'WITHDRAWN'/.test(def),
      def,
    );
  }

  const grants = await admin<{ privilege_type: string }[]>`
    SELECT privilege_type FROM information_schema.table_privileges
    WHERE table_schema = 'public_core' AND table_name = 'submission_requests'
      AND grantee = 'usrp_system_service'`;
  const granted = new Set(grants.map((g) => g.privilege_type));
  check('ledger grants SELECT to the writer', granted.has('SELECT'));
  check('ledger grants INSERT to the writer', granted.has('INSERT'));
  check('ledger is append-only: no UPDATE grant', !granted.has('UPDATE'), [...granted].join(','));
  check('ledger is append-only: no DELETE grant', !granted.has('DELETE'), [...granted].join(','));

  const rls = await admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public_core' AND c.relname = 'submission_requests'`;
  check('ledger has RLS enabled', rls[0]?.relrowsecurity === true);
  check('ledger has RLS FORCED (owner is not exempt)', rls[0]?.relforcerowsecurity === true);

  // ════════════════════════════════════════════════════════════════
  const config = loadApplicationConfig();
  const bus = new InMemoryEventBus();
  const service = createApplicationService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: PUBLIC_PEM,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });
  const server = await startHttpServer({
    serviceName: 'submission-integrity-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: [
      submitApplicationRoute(service.submit, verify),
      ...walkInRoutes(service.walkIn, verify),
    ],
    readiness: async () => true,
    handleSignals: false,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const SYSTEM_TOKEN = mint('system', 'submission-integrity-selfcheck');

  async function submit(
    body: Record<string, unknown>,
    idempotencyKey?: string | null,
  ): Promise<Reply> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${SYSTEM_TOKEN}`,
    };
    if (idempotencyKey !== undefined && idempotencyKey !== null) {
      headers['idempotency-key'] = idempotencyKey;
    }
    const res = await fetch(`${base}${SUBMIT_APPLICATION_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    return { status: res.status, json, text, replayed: res.headers.get('idempotency-replayed') };
  }

  const digitalBody = {
    applicantId: DIGITAL_APPLICANT,
    category: CATEGORY,
    channel: 'WEB',
    nesaIndexNumber: NESA,
  };

  try {
    // ══════════════════════════════════════════════════════════════
    console.log('\n── 3. HTTP idempotency contract ─────────────────────────────');
    const KEY = randomUUID();

    const first = await submit(digitalBody, KEY);
    check('first submit → 201 SUBMITTED', first.status === 201 && first.json['status'] === 'SUBMITTED', first.text);
    check('first submit is NOT marked replayed', first.replayed === null, String(first.replayed));
    const appId = String(first.json['applicationId']);
    const code = String(first.json['processingCode']);
    check('processingCode matches RDF-NNNNN', /^RDF-\d{5}$/.test(code), code);

    // The core guarantee: an identical retry is answered, not re-filed.
    const retry = await submit(digitalBody, KEY);
    check('identical retry → 201 (the original answer, repeated)', retry.status === 201, retry.text);
    check("identical retry sets Idempotency-Replayed: true", retry.replayed === 'true', String(retry.replayed));
    check('identical retry returns the SAME applicationId', retry.json['applicationId'] === appId, retry.text);
    check('identical retry returns the SAME processingCode', retry.json['processingCode'] === code, retry.text);
    check('still exactly ONE application row', (await countApplications(DIGITAL_APPLICANT)) === 1);
    check('still exactly ONE ledger row', (await countLedger(DIGITAL_APPLICANT)) === 1);

    // A retry sent through a DIFFERENT field order is the same request.
    const reordered = await submit(
      { channel: 'WEB', nesaIndexNumber: NESA, category: CATEGORY, applicantId: DIGITAL_APPLICANT },
      KEY,
    );
    check('retry with reordered body is still a replay', reordered.replayed === 'true', reordered.text);

    // Same key, materially different body → refused, and nothing written.
    const reused = await submit({ ...digitalBody, nesaIndexNumber: 'RW2024SC09999' }, KEY);
    check('same key + different body → 409', reused.status === 409, reused.text);
    check('…with status KEY_REUSED', reused.json['status'] === 'KEY_REUSED', reused.text);
    check('KEY_REUSED leaks no identifiers', reused.json['applicationId'] === undefined, reused.text);
    check('KEY_REUSED wrote nothing', (await countApplications(DIGITAL_APPLICANT)) === 1);

    // A brand-new key, but the citizen already holds a live application.
    const dupe = await submit(digitalBody, randomUUID());
    check('different key + live duplicate → 409', dupe.status === 409, dupe.text);
    check('…with status ALREADY_APPLIED', dupe.json['status'] === 'ALREADY_APPLIED', dupe.text);
    check('…naming the application already held', dupe.json['applicationId'] === appId, dupe.text);
    check('…and its processing code', dupe.json['processingCode'] === code, dupe.text);
    check('ALREADY_APPLIED wrote nothing', (await countApplications(DIGITAL_APPLICANT)) === 1);
    check('ALREADY_APPLIED spent no ledger row', (await countLedger(DIGITAL_APPLICANT)) === 1);

    const badKey = await submit(digitalBody, 'not-a-uuid');
    check('malformed Idempotency-Key → 400', badKey.status === 400, badKey.text);
    check('…INVALID_IDEMPOTENCY_KEY', badKey.json['error'] === 'INVALID_IDEMPOTENCY_KEY', badKey.text);

    // No key at all still works, and is still recorded.
    const keyless = await submit({ ...digitalBody, applicantId: KEYLESS_APPLICANT });
    check('submit without a key → 201', keyless.status === 201, keyless.text);
    check('…still writes a ledger row (server-minted key)', (await countLedger(KEYLESS_APPLICANT)) === 1);

    // ══════════════════════════════════════════════════════════════
    console.log('\n── 3b. The retry contract outlives the state it was made in ─');
    // The defect this section exists for: the ledger lookup used to sit AFTER
    // the identity and campaign reads, so the answer to "what did you tell me
    // last time?" depended on state that moves. A citizen whose 201 was lost
    // on a dropped connection — the entire scenario this slice is built for —
    // retried after the registration window closed and was told
    // NO_OPEN_CAMPAIGN: that they had never applied, while their application
    // sat filed in the database.
    //
    // A retry is a question about the PAST. It must be answerable from the
    // ledger alone.
    await admin`
      UPDATE public_core.recruitment_campaigns
      SET registration_closes_at = now() - interval '1 day' WHERE id = ${CAMPAIGN}`;
    const closed = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public_core.recruitment_campaigns
      WHERE id = ${CAMPAIGN} AND registration_closes_at < now()`;
    check('(the campaign really is closed now)', closed[0]?.n === 1);

    const lateRetry = await submit(digitalBody, KEY);
    check(
      'same key, campaign now CLOSED → still the original 201',
      lateRetry.status === 201,
      lateRetry.text,
    );
    check('…still flagged Idempotency-Replayed', lateRetry.replayed === 'true', String(lateRetry.replayed));
    check('…still the SAME applicationId', lateRetry.json['applicationId'] === appId, lateRetry.text);
    check('…still the SAME processingCode', lateRetry.json['processingCode'] === code, lateRetry.text);

    const lateReuse = await submit({ ...digitalBody, nesaIndexNumber: 'RW2024SC08888' }, KEY);
    check(
      'same key + different body under a closed campaign → KEY_REUSED, not NO_OPEN_CAMPAIGN',
      lateReuse.status === 409 && lateReuse.json['status'] === 'KEY_REUSED',
      lateReuse.text,
    );

    // The identity moving is the same class of problem.
    await admin`
      UPDATE public_core.applicant_identities
      SET identity_status = 'PENDING' WHERE id = ${DIGITAL_APPLICANT}`;
    const unverifiedRetry = await submit(digitalBody, KEY);
    check(
      'same key, identity no longer VERIFIED → still the original 201',
      unverifiedRetry.status === 201 && unverifiedRetry.json['applicationId'] === appId,
      unverifiedRetry.text,
    );
    await admin`
      UPDATE public_core.applicant_identities
      SET identity_status = 'VERIFIED' WHERE id = ${DIGITAL_APPLICANT}`;

    // The boundary of the fix: an UNSEEN key is a NEW submission and still
    // faces the preconditions. Only a key already answered is exempt.
    //
    // Deliberately NOT asserted here. Trying to pin it down showed why: with
    // this campaign closed, findOpenCampaign selects whatever OTHER open RDF
    // campaign exists, and the live-intent index is keyed per campaign, so
    // the submission succeeds as a second application in a different
    // campaign. That is the cross-campaign duplicate-intent question ADR-027
    // records as an owner policy decision, not a technical one — and the
    // answer here depends on which other campaigns happen to be open, so an
    // assertion would be pinning down an accident of fixture ordering rather
    // than a property of this slice.

    await admin`
      UPDATE public_core.recruitment_campaigns
      SET registration_closes_at = now() + interval '30 days' WHERE id = ${CAMPAIGN}`;
    check('nothing new was written throughout', (await countApplications(DIGITAL_APPLICANT)) === 1);
    check('…and no ledger row was spent', (await countLedger(DIGITAL_APPLICANT)) === 1);

    // ══════════════════════════════════════════════════════════════
    console.log('\n── 4. One transaction: row, trail, ledger, announcement ─────');
    const hist = await admin<{ from_status: string | null; to_status: string }[]>`
      SELECT from_status::text, to_status::text FROM rdf_ops.application_status_history
      WHERE application_id = ${appId}`;
    check('exactly one history row', hist.length === 1, `got ${hist.length}`);
    check('history is null → SUBMITTED', hist[0]?.from_status === null && hist[0]?.to_status === 'SUBMITTED');
    const ledger = await admin<{ application_id: string; processing_code: string; agency: string; request_hash: string }[]>`
      SELECT application_id, processing_code, agency::text, request_hash
      FROM public_core.submission_requests WHERE applicant_id = ${DIGITAL_APPLICANT}`;
    check('ledger row points at the created application', ledger[0]?.application_id === appId);
    check('ledger row carries its processing code', ledger[0]?.processing_code === code);
    check('ledger row records the owning agency', ledger[0]?.agency === 'RDF', String(ledger[0]?.agency));
    check(
      'ledger row stores the canonical hash of the request',
      ledger[0]?.request_hash ===
        canonicalRequestHash({
          applicantId: DIGITAL_APPLICANT,
          category: CATEGORY,
          channel: 'WEB',
          nesaIndexNumber: NESA,
          hecRegistrationNumber: null,
        }),
      String(ledger[0]?.request_hash),
    );
    check(
      'exactly ONE APPLICANT_SUBMITTED staged for the whole sequence',
      (await countSubmittedEvents(DIGITAL_APPLICANT)) === 1,
      String(await countSubmittedEvents(DIGITAL_APPLICANT)),
    );
    const busSubmits = bus.published.filter(
      (e) => e.eventType === 'APPLICANT_SUBMITTED' &&
        (e as unknown as Record<string, unknown>)['applicantId'] === DIGITAL_APPLICANT,
    );
    check('…and exactly one reached the bus', busSubmits.length === 1, String(busSubmits.length));

    // ══════════════════════════════════════════════════════════════
    console.log('\n── 5. Concurrency ───────────────────────────────────────────');
    // 5a. Eight simultaneous deliveries of the SAME request. They meet on the
    //     ledger's primary key; exactly one may file.
    const sameKey = randomUUID();
    const sameBody = { ...digitalBody, applicantId: RACE_SAME_KEY_APPLICANT };
    const sameResults = await Promise.all(
      Array.from({ length: 8 }, () => submit(sameBody, sameKey)),
    );
    const created201 = sameResults.filter((r) => r.status === 201 && r.replayed === null);
    const replayed201 = sameResults.filter((r) => r.status === 201 && r.replayed === 'true');
    check('8 identical concurrent retries: exactly one FILED', created201.length === 1, String(created201.length));
    check('…the other 7 replayed', replayed201.length === 7, String(replayed201.length));
    check('…exactly one application row exists', (await countApplications(RACE_SAME_KEY_APPLICANT)) === 1);
    check('…exactly one ledger row exists', (await countLedger(RACE_SAME_KEY_APPLICANT)) === 1);
    check('…exactly one APPLICANT_SUBMITTED', (await countSubmittedEvents(RACE_SAME_KEY_APPLICANT)) === 1);
    const distinctIds = new Set(sameResults.map((r) => String(r.json['applicationId'])));
    check('…every caller got the SAME applicationId', distinctIds.size === 1, [...distinctIds].join(','));

    // 5b. Eight simultaneous requests with DIFFERENT keys. The ledger cannot
    //     help here — this is the engine's live-intent index alone.
    const diffBody = { ...digitalBody, applicantId: RACE_DIFF_KEY_APPLICANT };
    const diffResults = await Promise.all(
      Array.from({ length: 8 }, () => submit(diffBody, randomUUID())),
    );
    const diffCreated = diffResults.filter((r) => r.status === 201);
    const diffDupes = diffResults.filter(
      (r) => r.status === 409 && r.json['status'] === 'ALREADY_APPLIED',
    );
    check('8 concurrent DIFFERENT keys: exactly one filed', diffCreated.length === 1, String(diffCreated.length));
    check('…the other 7 → ALREADY_APPLIED (no 5xx)', diffDupes.length === 7, JSON.stringify(diffResults.map((r) => r.status)));
    check('…exactly one application row exists', (await countApplications(RACE_DIFF_KEY_APPLICANT)) === 1);
    check('…exactly one APPLICANT_SUBMITTED', (await countSubmittedEvents(RACE_DIFF_KEY_APPLICANT)) === 1);
    // The losers' keys rolled back with their transactions, so they are unspent.
    check('…losing keys were not spent', (await countLedger(RACE_DIFF_KEY_APPLICANT)) === 1, String(await countLedger(RACE_DIFF_KEY_APPLICANT)));

    // ══════════════════════════════════════════════════════════════
    console.log('\n── 6. The walk-in lane obeys the same invariant ─────────────');
    // The citizen who already applied online, now standing at the venue.
    const online = await submit({ ...digitalBody, applicantId: ONLINE_THEN_WALKIN_APPLICANT }, randomUUID());
    check('online submission filed', online.status === 201, online.text);
    const onlineId = String(online.json['applicationId']);

    const officerHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${mint('officer', RDF_OFFICER_ID)}`,
    };
    const register = async (applicantId: string): Promise<Reply> => {
      const res = await fetch(`${base}${WALK_IN_REGISTER_PATH}`, {
        method: 'POST',
        headers: officerHeaders,
        body: JSON.stringify({ applicantId, category: CATEGORY, nesaIndexNumber: NESA }),
      });
      const text = await res.text();
      return {
        status: res.status,
        json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
        text,
        replayed: null,
      };
    };

    const reg1 = await register(WALK_IN_APPLICANT);
    check('walk-in register → 201 REGISTERED', reg1.status === 201 && reg1.json['status'] === 'REGISTERED', reg1.text);
    const walkInCode = String(reg1.json['processingCode']);

    // The double-tap on the officer's tablet.
    const reg2 = await register(WALK_IN_APPLICANT);
    check('duplicate walk-in register → 409 (not a 500)', reg2.status === 409, reg2.text);
    check('…with status ALREADY_APPLIED', reg2.json['status'] === 'ALREADY_APPLIED', reg2.text);
    check('…naming the existing processing code', reg2.json['processingCode'] === walkInCode, reg2.text);
    check('…exactly one walk-in application exists', (await countApplications(WALK_IN_APPLICANT)) === 1);
    const walkInSubmits = bus.published.filter(
      (e) => e.eventType === 'APPLICANT_SUBMITTED' &&
        (e as unknown as Record<string, unknown>)['applicantId'] === WALK_IN_APPLICANT,
    );
    check('…and the duplicate announced NOTHING', walkInSubmits.length === 1, String(walkInSubmits.length));

    // Cross-lane: online first, then the venue. Same campaign, same category.
    const crossLane = await register(ONLINE_THEN_WALKIN_APPLICANT);
    check(
      'a citizen who applied online cannot be walk-in registered again',
      crossLane.status === 409 && crossLane.json['status'] === 'ALREADY_APPLIED',
      crossLane.text,
    );
    check('…and is pointed at the application already on file', crossLane.json['applicationId'] === onlineId, crossLane.text);

    // ══════════════════════════════════════════════════════════════
    console.log('\n── 7. Withdrawal frees the intent (the partial predicate) ───');
    const withdrawn = await register(WITHDRAWN_APPLICANT);
    check('withdrawal fixture registered', withdrawn.status === 201, withdrawn.text);
    const withdrawnId = String(withdrawn.json['applicationId']);
    const blocked = await register(WITHDRAWN_APPLICANT);
    check('…a second attempt is blocked while it is live', blocked.status === 409, blocked.text);
    await admin`UPDATE rdf_ops.applications SET status = 'WITHDRAWN' WHERE id = ${withdrawnId}`;
    const reapply = await register(WITHDRAWN_APPLICANT);
    check(
      'after WITHDRAWN the citizen may genuinely re-apply',
      reapply.status === 201 && reapply.json['status'] === 'REGISTERED',
      reapply.text,
    );
    check(
      '…leaving one withdrawn + one live application',
      (await countApplications(WITHDRAWN_APPLICANT)) === 2,
      String(await countApplications(WITHDRAWN_APPLICANT)),
    );
    // ══════════════════════════════════════════════════════════════
    console.log('\n── 7b. REJECTED does NOT free the intent ───────────────────');
    // The index predicate spares only WITHDRAWN, so a rejected application
    // still occupies the citizen's one live intent. That is a policy choice
    // with real consequences for a rejected candidate, so it is asserted
    // rather than left to be inferred from the SQL.
    await admin`UPDATE rdf_ops.applications SET status = 'REJECTED' WHERE id = ${appId}`;
    const afterReject = await submit(digitalBody, randomUUID());
    check(
      'a REJECTED application still blocks a new one',
      afterReject.status === 409 && afterReject.json['status'] === 'ALREADY_APPLIED',
      afterReject.text,
    );
    check('…naming the rejected application', afterReject.json['applicationId'] === appId, afterReject.text);
    check('…and writing nothing', (await countApplications(DIGITAL_APPLICANT)) === 1);
    await admin`UPDATE rdf_ops.applications SET status = 'SUBMITTED' WHERE id = ${appId}`;
  } finally {
    await server.stop();
    await cleanup();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('ALL SUBMISSION-INTEGRITY ASSERTIONS PASSED ✓');
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
