// ══════════════════════════════════════════════════════════════════
// application-service — Operational read models, LIVE proof (ADR-039)
//
//   GET /v1/campaigns/admin          GET /v1/campaigns/admin/detail
//   GET /v1/applications/search      GET /v1/venue-roster
//
// Real Postgres, real RLS, real officer DB roles, the real routes behind a real
// HTTP server. Negative paths are the point:
//   • agency isolation: a sibling agency's campaign is BYTE-IDENTICAL to a
//     nonexistent one (404), and never appears in a list;
//   • wrong permission and system tokens are refused;
//   • the keyset cursor is stable across an insert BETWEEN two page fetches
//     (no row repeated, none skipped) — including a tie on the sort key;
//   • a filter that matches nothing is an empty page with total 0, not an error;
//   • the roster carries ONLY the allowlisted keys: no name, NID, hash, applicant
//     id, QR token or phone can appear, asserted both by key set and by scanning
//     the raw body for the seeded sentinels.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/application-service/selfcheck/verify-operational-reads.ts
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import { createApplicationService, loadApplicationConfig, operationalReadRoutes } from '../src/index.js';

const AUTH_KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(AUTH_KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const admin = postgres(
  process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db',
  { onnotice: () => {} },
);

// ── Fixtures (9d… prefix: no collision with other proofs) ───────────
const ACTOR = '9d0f1cee-0000-4000-8000-00000000f1ce';
const C_OPEN = '9d100000-0000-4000-8000-000000000001'; // RDF, REGISTRATION_OPEN
const C_DRAFT = '9d100000-0000-4000-8000-000000000002'; // RDF, DRAFT
const C_RNP = '9d100000-0000-4000-8000-000000000003'; // RNP
const C_NEW = '9d100000-0000-4000-8000-000000000004'; // RDF, inserted MID-PAGINATION
const CODE_OPEN = 'S04-RDF-OPEN';
const CODE_DRAFT = 'S04-RDF-DRAFT';
const CODE_RNP = 'S04-RNP-OPEN';
const CODE_NEW = 'S04-RDF-NEWEST';
const POLICY_ID = '9d200000-0000-4000-8000-000000000001';
const POLICY_HASH = 'ab'.repeat(32);
const COVERAGE_HASH = 'cd'.repeat(32);
const EXAM_DATE = '2026-10-21';
const NID_SENTINEL = 'f9f9f9f9'.repeat(8);
const QR_SENTINEL = 'QR-SENTINEL-MUST-NOT-LEAK-9d';
const PHONE_SENTINEL = '0788999111';

interface Seed { n: number; code: string; category: string; status: string; district: string | null; daysAgo: number; admitted?: boolean; policy?: boolean }
// n=2 and n=3 share submitted_at exactly (a keyset TIE the cursor must break by id).
const SEEDS: readonly Seed[] = [
  { n: 1, code: 'RDF-97001', category: 'GENERAL_ENLISTMENT', status: 'SLOT_ASSIGNED', district: 'GASABO', daysAgo: 1 },
  { n: 2, code: 'RDF-97002', category: 'GENERAL_ENLISTMENT', status: 'PHYSICAL_TEST_SCHEDULED', district: 'GASABO', daysAgo: 3, admitted: true, policy: true },
  { n: 3, code: 'RDF-97003', category: 'RESERVE_FORCE_UNIVERSITY', status: 'SLOT_ASSIGNED', district: 'GASABO', daysAgo: 3 },
  { n: 4, code: 'RDF-97004', category: 'GENERAL_ENLISTMENT', status: 'SLOT_ASSIGNED', district: 'HUYE', daysAgo: 5 },
  { n: 5, code: 'RDF-97005', category: 'GENERAL_ENLISTMENT', status: 'SUBMITTED', district: null, daysAgo: 8 },
  { n: 6, code: 'RDF-97006', category: 'RESERVE_FORCE_UNIVERSITY', status: 'REJECTED', district: 'GASABO', daysAgo: 12 },
  { n: 7, code: 'RDF-97007', category: 'GENERAL_ENLISTMENT', status: 'ACADEMIC_VETTING', district: null, daysAgo: 20 },
];
const appId = (n: number): string => `9d3000${String(n).padStart(2, '0')}-0000-4000-8000-000000000000`;
const applicantId = (n: number): string => `9d4000${String(n).padStart(2, '0')}-0000-4000-8000-000000000000`;
const RNP_APP = '9d300099-0000-4000-8000-000000000000';
const RNP_APPLICANT = '9d400099-0000-4000-8000-000000000000';
const NEW_APP = '9d300098-0000-4000-8000-000000000000';
const NEW_APPLICANT = '9d400098-0000-4000-8000-000000000000';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function mint(roles: readonly string[], agency: 'RDF' | 'RNP' | 'RCS' = 'RDF'): string {
  const claims: AuthTokenClaims = {
    v: 1, iss: 'usrp', aud: 'usrp-services', sub: ACTOR,
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
    kind: 'officer', agency, roles: [...roles],
  };
  return signAuthToken(AUTH_KEYS.privateKeyPem, claims);
}
const mintSystem = (): string =>
  signAuthToken(AUTH_KEYS.privateKeyPem, {
    v: 1, iss: 'usrp', aud: 'usrp-services', sub: ACTOR,
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z', kind: 'system',
  });

const ADMIN_TOKEN = mint(['agency_admin']);
const SCREENING = mint(['screening_officer']);

const ALL_APPLICANTS = [...SEEDS.map((s) => applicantId(s.n)), RNP_APPLICANT, NEW_APPLICANT];
const ALL_CAMPAIGNS = [C_OPEN, C_DRAFT, C_RNP, C_NEW];

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const schema of ['rdf_ops', 'rnp_ops'] as const) {
      await tx`DELETE FROM ${tx(schema)}.gate_admissions WHERE application_id IN (SELECT id FROM ${tx(schema)}.applications WHERE applicant_id IN ${tx(ALL_APPLICANTS)})`;
      await tx`DELETE FROM ${tx(schema)}.application_status_history WHERE application_id IN (SELECT id FROM ${tx(schema)}.applications WHERE applicant_id IN ${tx(ALL_APPLICANTS)})`;
      await tx`DELETE FROM ${tx(schema)}.applications WHERE applicant_id IN ${tx(ALL_APPLICANTS)}`;
    }
    await tx`UPDATE public_core.recruitment_campaigns SET current_policy_version_id = NULL WHERE id IN ${tx(ALL_CAMPAIGNS)}`;
    await tx`DELETE FROM public_core.campaign_lifecycle_history WHERE campaign_id IN ${tx(ALL_CAMPAIGNS)}`;
    await tx`DELETE FROM public_core.campaign_coverage_heads WHERE campaign_id IN ${tx(ALL_CAMPAIGNS)}`;
    await tx`DELETE FROM public_core.campaign_venue_assignments WHERE campaign_id IN ${tx(ALL_CAMPAIGNS)}`;
    await tx`DELETE FROM public_core.campaign_policy_versions WHERE campaign_id IN ${tx(ALL_CAMPAIGNS)}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx(ALL_CAMPAIGNS)}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx(ALL_APPLICANTS)}`;
  });
}

async function seedApplicant(id: string, n: number): Promise<void> {
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender, registration_channel, identity_status)
    VALUES (${id}, ${`${String(n).padStart(2, '0')}${NID_SENTINEL.slice(2)}`}, ${`NAME-SENTINEL-${String(n)}`}, 'x', 'x', 'x', 'MALE', 'WEB',
            'VERIFIED'::public_core.identity_verification_status)`;
}

async function seedCampaign(id: string, code: string, agency: 'RDF' | 'RNP', status: string, createdAt: string): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO public_core.recruitment_campaigns
        (id, public_code, campaign_label, agency, status, target_categories, target_districts,
         registration_opens_at, registration_closes_at, examination_start_date, examination_end_date,
         examination_reporting_hour, created_at)
      VALUES (${id}, ${code}, ${`Label ${code}`}, ${agency}::public_core.agency,
              ${status}::public_core.campaign_status,
              ${agency === 'RDF' ? '["GENERAL_ENLISTMENT","RESERVE_FORCE_UNIVERSITY"]' : '["CADET_OFFICER"]'},
              ${tx.json(['GASABO', 'HUYE'])},
              now() - interval '1 day', now() + interval '30 days', ${EXAM_DATE}, '2026-10-27', 7, ${createdAt}::timestamptz)`;
  });
}

let tieInstant = '';
let tieDay = '';

async function seed(): Promise<void> {
  await seedCampaign(C_OPEN, CODE_OPEN, 'RDF', 'REGISTRATION_OPEN', '2026-10-01T08:00:00Z');
  await seedCampaign(C_DRAFT, CODE_DRAFT, 'RDF', 'DRAFT', '2026-10-02T08:00:00Z');
  await seedCampaign(C_RNP, CODE_RNP, 'RNP', 'REGISTRATION_OPEN', '2026-10-03T08:00:00Z');

  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO public_core.campaign_policy_versions
        (id, campaign_id, agency, version_number, policy_document, policy_hash, hash_version,
         legal_basis_code, legal_basis_reference, created_by)
      VALUES (${POLICY_ID}, ${C_OPEN}, 'RDF', 1,
              ${tx.json({ GENERAL_ENLISTMENT: { requiredDocumentTypes: ['NATIONAL_ID', 'BIRTH_CERTIFICATE'] } })},
              ${POLICY_HASH}, 1, 'SYNTHETIC', 'S04 proof', ${ACTOR})`;
    await tx`UPDATE public_core.recruitment_campaigns SET current_policy_version_id = ${POLICY_ID} WHERE id = ${C_OPEN}`;
    await tx`
      INSERT INTO public_core.campaign_coverage_heads (campaign_id, agency, coverage_version, coverage_hash)
      VALUES (${C_OPEN}, 'RDF', 2, ${COVERAGE_HASH})`;
    await tx`
      INSERT INTO public_core.campaign_venue_assignments
        (campaign_id, district, province, venue_name, exam_date, reporting_time_hour, capacity_limit, capacity_decision_code, registered_count)
      VALUES (${C_OPEN}, 'GASABO', 'KIGALI_CITY', 'Rehearsal Venue — Gasabo', ${EXAM_DATE}, 7, 3, NULL, 2),
             (${C_OPEN}, 'HUYE', 'SOUTHERN_PROVINCE', 'Rehearsal Venue — Huye', ${EXAM_DATE}, 7, NULL, 'UNBOUNDED_CAPACITY', 1)`;
    await tx`
      INSERT INTO public_core.campaign_lifecycle_history
        (campaign_id, agency, from_status, to_status, actor_id, correlation_id, reason_code, occurred_at)
      VALUES (${C_OPEN}, 'RDF', NULL, 'DRAFT', ${ACTOR}, 'c-1', NULL, '2026-10-01T08:00:00Z'),
             (${C_OPEN}, 'RDF', 'DRAFT', 'REGISTRATION_OPEN', ${ACTOR}, 'c-2', NULL, '2026-10-01T09:00:00Z')`;
  });

  for (const s of SEEDS) {
    await seedApplicant(applicantId(s.n), s.n);
  }
  // n=2 and n=3 share one exact instant (microseconds included).
  const [tieRow] = await admin<{ tie: string; tie_day: string }[]>`
    SELECT (date_trunc('second', now()) - interval '6 days' + interval '123456 microseconds')::text AS tie,
           ((date_trunc('second', now()) - interval '6 days') AT TIME ZONE 'Africa/Kigali')::date::text AS tie_day`;
  tieInstant = tieRow?.tie ?? '';
  tieDay = tieRow?.tie_day ?? '';
  for (const s of SEEDS) {
    const submittedAt = s.n === 2 || s.n === 3 ? tieInstant : null;
    await admin.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        INSERT INTO rdf_ops.applications
          (id, processing_code, applicant_id, campaign_id, category, status, assigned_district, assigned_venue_name,
           qr_invitation_code, policy_version_id, submitted_at)
        VALUES (${appId(s.n)}, ${s.code}, ${applicantId(s.n)}, ${C_OPEN}, ${s.category},
                ${s.status}::rdf_ops.application_status, ${s.district}, ${s.district === null ? null : `Rehearsal Venue — ${s.district}`},
                ${`${QR_SENTINEL}-${String(s.n)}`}, ${s.policy === true ? POLICY_ID : null},
                ${submittedAt ?? sql`now() - make_interval(days => ${s.daysAgo})`})`;
      if (s.admitted === true) {
        await tx`
          INSERT INTO rdf_ops.gate_admissions (application_id, ticket_id, campaign_id, venue_name, exam_date, identity_method, admitted_by_id)
          VALUES (${appId(s.n)}, ${`TICKET-${s.code}`}, ${C_OPEN}, 'Rehearsal Venue — Gasabo', ${EXAM_DATE}, 'NATIONAL_ID_CARD', ${ACTOR})`;
      }
    });
  }
  await seedApplicant(RNP_APPLICANT, 99);
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status, submitted_at)
      VALUES (${RNP_APP}, 'RNP-97001', ${RNP_APPLICANT}, ${C_RNP}, 'CADET_OFFICER',
              'SUBMITTED'::rnp_ops.application_status, now())`;
  });
}

type Json = Record<string, unknown>;
const asRecord = (v: unknown): Json => (v !== null && typeof v === 'object' ? (v as Json) : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

async function main(): Promise<void> {
  const config = loadApplicationConfig();
  const service = createApplicationService(config, new InMemoryEventBus());
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });
  await cleanup();
  await seed();

  const server = await startHttpServer({
    serviceName: 'application-service-operational-reads-selfcheck',
    port: 0,
    host: '127.0.0.1',
    routes: operationalReadRoutes(service.operationalReads, verify),
    handleSignals: false,
  });
  const base = server.url;

  async function get(path: string, token?: string): Promise<{ status: number; text: string; json: Json }> {
    const res = await fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    const text = await res.text();
    let json: Json = {};
    try { json = text ? asRecord(JSON.parse(text)) : {}; } catch { json = {}; }
    return { status: res.status, text, json };
  }
  const codes = (json: Json, key: string, field: string): string[] =>
    asArray(json[key]).map((r) => String(asRecord(r)[field]));

  try {
    console.log('\n── 1. Admin campaign list: all states, agency-scoped, filterable ──');
    const list = await get('/v1/campaigns/admin?q=S04-', ADMIN_TOKEN);
    check('agency_admin → 200', list.status === 200, `${list.status} ${list.text}`);
    check('agency comes from the token (RDF)', list.json['agency'] === 'RDF');
    const listed = codes(list.json, 'campaigns', 'publicCode');
    check('both RDF campaigns listed, DRAFT included', listed.includes(CODE_OPEN) && listed.includes(CODE_DRAFT), listed.join(','));
    check('the RNP campaign is NOT listed to an RDF administrator', !listed.includes(CODE_RNP));
    check('total counts the matches', list.json['total'] === 2, String(list.json['total']));
    check('newest first (DRAFT created later)', listed[0] === CODE_DRAFT, listed.join(','));
    check('no internal campaign UUID in the list', !list.text.includes(C_OPEN) && !list.text.includes(C_DRAFT));
    const open = asRecord(asArray(list.json['campaigns']).find((c) => asRecord(c)['publicCode'] === CODE_OPEN));
    const occ = asRecord(open['occupancy']);
    check('occupancy rolls up sessions', occ['sessionCount'] === 2, JSON.stringify(occ));
    check('occupancy rolls up registered_count', occ['registeredTotal'] === 3, JSON.stringify(occ));
    check('bounded capacity total excludes the unbounded session', occ['capacityTotal'] === 3 && occ['hasUnboundedSession'] === true, JSON.stringify(occ));

    const draftOnly = await get('/v1/campaigns/admin?q=S04-&status=DRAFT', ADMIN_TOKEN);
    check('status filter narrows', JSON.stringify(codes(draftOnly.json, 'campaigns', 'publicCode')) === JSON.stringify([CODE_DRAFT]) && draftOnly.json['total'] === 1);
    const none = await get('/v1/campaigns/admin?q=NO-SUCH-CAMPAIGN', ADMIN_TOKEN);
    check('filter-empty state is 200 with total 0 and no cursor', none.status === 200 && none.json['total'] === 0 && asArray(none.json['campaigns']).length === 0 && none.json['nextCursor'] === null, none.text);
    const wildcard = await get('/v1/campaigns/admin?q=%25', ADMIN_TOKEN);
    check('LIKE wildcards in q are literal', wildcard.status === 200 && wildcard.json['total'] === 0, wildcard.text);

    console.log('\n── 2. Cursor: stable across an insert between two page fetches ──');
    const page1 = await get('/v1/campaigns/admin?q=S04-&limit=1', ADMIN_TOKEN);
    const cursor1 = String(page1.json['nextCursor']);
    check('page 1 serves one row and a cursor', asArray(page1.json['campaigns']).length === 1 && typeof page1.json['nextCursor'] === 'string');
    // A NEWER campaign appears between the fetches: it must not shift page 2.
    await seedCampaign(C_NEW, CODE_NEW, 'RDF', 'DRAFT', '2026-10-09T08:00:00Z');
    const page2 = await get(`/v1/campaigns/admin?q=S04-&limit=1&cursor=${cursor1}`, ADMIN_TOKEN);
    const p1 = codes(page1.json, 'campaigns', 'publicCode');
    const p2 = codes(page2.json, 'campaigns', 'publicCode');
    check('page 2 is the next older row (no repeat, no skip)', p1[0] === CODE_DRAFT && p2[0] === CODE_OPEN, `${p1.join()} | ${p2.join()}`);
    check('last page has no cursor', page2.json['nextCursor'] === null);
    check('total reflects the insert (it is a count, not a position)', page2.json['total'] === 3, String(page2.json['total']));
    for (const bad of ['!!!', 'e30', Buffer.from('{"k":"x","i":"y"}').toString('base64url')]) {
      const r = await get(`/v1/campaigns/admin?cursor=${bad}`, ADMIN_TOKEN);
      check(`forged cursor "${bad.slice(0, 12)}" → 400 INVALID_CURSOR`, r.status === 400, `${r.status} ${r.text}`);
    }

    console.log('\n── 3. Admin detail: sessions, occupancy, policy version and hash ──');
    const detail = await get(`/v1/campaigns/admin/detail?publicCode=${CODE_OPEN}`, ADMIN_TOKEN);
    const camp = asRecord(detail.json['campaign']);
    check('detail → 200', detail.status === 200, `${detail.status} ${detail.text}`);
    check('policy version and hash returned', asRecord(camp['policy'])['versionNumber'] === 1 && asRecord(camp['policy'])['policyHash'] === POLICY_HASH, JSON.stringify(camp['policy']));
    check('coverage version and hash returned', asRecord(camp['coverage'])['version'] === 2 && asRecord(camp['coverage'])['hash'] === COVERAGE_HASH);
    const sessions = asArray(camp['sessions']).map(asRecord);
    const gasabo = sessions.find((s) => s['district'] === 'GASABO') ?? {};
    const huye = sessions.find((s) => s['district'] === 'HUYE') ?? {};
    check('GASABO: capacity_limit 3, registered_count 2, remaining 1', gasabo['capacityLimit'] === 3 && gasabo['registeredCount'] === 2 && gasabo['remaining'] === 1, JSON.stringify(gasabo));
    check('HUYE: explicitly unbounded (no limit, decision code, no remaining)', huye['capacityLimit'] === null && huye['capacityDecisionCode'] === 'UNBOUNDED_CAPACITY' && huye['remaining'] === null, JSON.stringify(huye));
    check('lifecycle history oldest first', asArray(camp['history']).length === 2 && asRecord(asArray(camp['history'])[1])['toStatus'] === 'REGISTRATION_OPEN');
    check('no actor id or internal UUID in the detail', !detail.text.includes(ACTOR) && !detail.text.includes(C_OPEN) && !detail.text.includes(POLICY_ID));
    const sibling = await get(`/v1/campaigns/admin/detail?publicCode=${CODE_RNP}`, ADMIN_TOKEN);
    const ghost = await get('/v1/campaigns/admin/detail?publicCode=S04-DOES-NOT-EXIST', ADMIN_TOKEN);
    check('a sibling agency campaign is 404', sibling.status === 404);
    check('…BYTE-IDENTICAL to a nonexistent code (no existence oracle)', sibling.text === ghost.text && ghost.status === 404, `${sibling.text} vs ${ghost.text}`);
    check('RNP administrator cannot read RDF campaign detail either', (await get(`/v1/campaigns/admin/detail?publicCode=${CODE_OPEN}`, mint(['agency_admin'], 'RNP'))).status === 404);
    check('missing publicCode → 400', (await get('/v1/campaigns/admin/detail', ADMIN_TOKEN)).status === 400);

    console.log('\n── 4. Permissions: wrong role, no token, system token ──');
    for (const path of ['/v1/campaigns/admin', `/v1/campaigns/admin/detail?publicCode=${CODE_OPEN}`]) {
      const wrong = await get(path, SCREENING);
      check(`${path.split('?')[0]}: screening_officer → 403 PERMISSION_DENIED`, wrong.status === 403 && wrong.text.includes('PERMISSION_DENIED'), `${wrong.status} ${wrong.text}`);
      check(`${path.split('?')[0]}: no token → 401`, (await get(path)).status === 401);
      check(`${path.split('?')[0]}: system token → 403`, (await get(path, mintSystem())).status === 403);
    }
    check('reviewer (read-only) may read the campaign list', (await get('/v1/campaigns/admin?q=S04-', mint(['reviewer']))).status === 200);
    check('applications/search: dpo (no application.read) → 403', (await get('/v1/applications/search', mint(['dpo']))).status === 403);

    console.log('\n── 5. Application search: filters, total, cursor ──');
    const REVIEWER = mint(['reviewer']);
    const all = await get('/v1/applications/search?campaign=' + CODE_OPEN + '&limit=100', REVIEWER);
    const allCodes = codes(all.json, 'applications', 'processingCode');
    check('7 RDF applications, newest first (tie broken by id desc)', JSON.stringify(allCodes) === JSON.stringify(['RDF-97001', 'RDF-97004', 'RDF-97003', 'RDF-97002', 'RDF-97005', 'RDF-97006', 'RDF-97007']), allCodes.join());
    check('total = 7', all.json['total'] === 7);
    check('the RNP application never appears', !all.text.includes('RNP-97001'));
    check('no applicant id, NID hash, name or QR token', !all.text.includes(applicantId(1)) && !all.text.includes(NID_SENTINEL.slice(2)) && !all.text.includes('NAME-SENTINEL') && !all.text.includes(QR_SENTINEL));
    const rowKeys = Object.keys(asRecord(asArray(all.json['applications'])[0])).sort().join();
    check('row keys are exactly the allowlist', rowKeys === 'applicationId,category,processingCode,status,submittedAt', rowKeys);

    const byStatus = await get(`/v1/applications/search?campaign=${CODE_OPEN}&status=SLOT_ASSIGNED&status=SUBMITTED`, REVIEWER);
    check('status[] (repeatable) filter + total', byStatus.json['total'] === 4 && codes(byStatus.json, 'applications', 'processingCode').sort().join() === 'RDF-97001,RDF-97003,RDF-97004,RDF-97005', byStatus.text);
    const byStatusCsv = await get(`/v1/applications/search?campaign=${CODE_OPEN}&status=SLOT_ASSIGNED,SUBMITTED`, REVIEWER);
    check('status as a comma list is equivalent', byStatusCsv.json['total'] === 4);
    const byCat = await get(`/v1/applications/search?campaign=${CODE_OPEN}&category=RESERVE_FORCE_UNIVERSITY`, REVIEWER);
    check('category filter', byCat.json['total'] === 2);
    const byDistrict = await get(`/v1/applications/search?campaign=${CODE_OPEN}&district=HUYE`, REVIEWER);
    check('district filter', byDistrict.json['total'] === 1 && codes(byDistrict.json, 'applications', 'processingCode')[0] === 'RDF-97004');
    const byRange = await get(`/v1/applications/search?campaign=${CODE_OPEN}&submittedFrom=${tieDay}&submittedTo=${tieDay}`, REVIEWER);
    check('submitted range (inclusive Kigali day) catches the tied pair', byRange.json['total'] === 2, byRange.text);
    const combined = await get(`/v1/applications/search?campaign=${CODE_OPEN}&status=SLOT_ASSIGNED&category=GENERAL_ENLISTMENT&district=GASABO`, REVIEWER);
    check('filters AND together', combined.json['total'] === 1 && codes(combined.json, 'applications', 'processingCode')[0] === 'RDF-97001');
    const nothing = await get(`/v1/applications/search?campaign=${CODE_OPEN}&status=ACCEPTED`, REVIEWER);
    check('filter-empty: 200, total 0, empty list, no cursor', nothing.status === 200 && nothing.json['total'] === 0 && asArray(nothing.json['applications']).length === 0 && nothing.json['nextCursor'] === null, nothing.text);
    const otherCampaign = await get(`/v1/applications/search?campaign=${CODE_RNP}`, REVIEWER);
    check("another agency's campaign code matches nothing (not an error, not a leak)", otherCampaign.status === 200 && otherCampaign.json['total'] === 0);
    for (const [label, q] of [['status', 'status=NOT_A_STATUS'], ['category', 'category=NOPE'], ['district', 'district=ATLANTIS'], ['date', 'submittedFrom=2026-13-45'], ['range', 'submittedFrom=2026-10-02&submittedTo=2026-10-01'], ['limit', 'limit=0'], ['limit', 'limit=1000']] as const) {
      const r = await get(`/v1/applications/search?${q}`, REVIEWER);
      check(`invalid ${label} (${q}) → 400`, r.status === 400, `${r.status} ${r.text}`);
    }

    console.log('\n── 6. Application cursor: complete, in order, stable across a concurrent insert ──');
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `/v1/applications/search?campaign=${CODE_OPEN}&limit=3${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page = await get(q, REVIEWER);
      seen.push(...codes(page.json, 'applications', 'processingCode'));
      pages += 1;
      if (pages === 1) {
        // A NEWER application is filed after page 1 was served. It must not displace page 2.
        await seedApplicant(NEW_APPLICANT, 98);
        await admin.begin(async (tx) => {
          await tx`SET LOCAL session_replication_role = replica`;
          await tx`
            INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status, submitted_at)
            VALUES (${NEW_APP}, 'RDF-97098', ${NEW_APPLICANT}, ${C_OPEN}, 'GENERAL_ENLISTMENT', 'SUBMITTED'::rdf_ops.application_status, now())`;
        });
      }
      cursor = typeof page.json['nextCursor'] === 'string' ? page.json['nextCursor'] : null;
    } while (cursor !== null && pages < 10);
    check('3 pages of 3/3/1', pages === 3, String(pages));
    check('every original row exactly once, in order, none repeated by the insert', JSON.stringify(seen) === JSON.stringify(['RDF-97001', 'RDF-97004', 'RDF-97003', 'RDF-97002', 'RDF-97005', 'RDF-97006', 'RDF-97007']), seen.join());
    check('the newer application appears at the head of a fresh read', codes((await get(`/v1/applications/search?campaign=${CODE_OPEN}&limit=1`, REVIEWER)).json, 'applications', 'processingCode')[0] === 'RDF-97098');
    const rnp = await get('/v1/applications/search', mint(['reviewer'], 'RNP'));
    check('RNP officer sees only RNP applications', codes(rnp.json, 'applications', 'processingCode').every((c) => c.startsWith('RNP-')) && rnp.text.includes('RNP-97001') && !rnp.text.includes('RDF-97001'));

    console.log('\n── 7. Venue roster: minimum set, no identity ──');
    const rosterPath = `/v1/venue-roster?campaign=${CODE_OPEN}&district=GASABO&examDate=${EXAM_DATE}`;
    const roster = await get(rosterPath, SCREENING);
    check('screening_officer (admission.gate) → 200', roster.status === 200, `${roster.status} ${roster.text}`);
    const cand = asArray(roster.json['candidates']).map(asRecord);
    check('exactly the slot-bearing GASABO candidates (not HUYE, not SUBMITTED, not REJECTED)', cand.map((c) => c['processingCode']).join() === 'RDF-97001,RDF-97002,RDF-97003', cand.map((c) => c['processingCode']).join());
    check('venue header names the venue day', asRecord(roster.json['venue'])['venueName'] === 'Rehearsal Venue — Gasabo' && asRecord(roster.json['venue'])['examDate'] === EXAM_DATE);
    check('admission state from gate_admissions', cand[0]?.['admission'] === 'NOT_ADMITTED' && cand[1]?.['admission'] === 'ADMITTED', JSON.stringify(cand.map((c) => c['admission'])));
    check('policy-bound candidate shows the policy paper list', JSON.stringify(cand[1]?.['requiredPaperItems']) === JSON.stringify(['BIRTH_CERTIFICATE', 'NATIONAL_ID']), JSON.stringify(cand[1]?.['requiredPaperItems']));
    check('policy-less candidate falls back to the ground-truth table', asArray(cand[0]?.['requiredPaperItems']).length > 0);
    const keys = new Set(cand.flatMap((c) => Object.keys(c)));
    check('candidate keys are EXACTLY the allowlist', [...keys].sort().join() === 'admission,category,processingCode,requiredPaperItems,status', [...keys].join());
    for (const forbidden of [NID_SENTINEL.slice(2), 'NAME-SENTINEL', QR_SENTINEL, PHONE_SENTINEL, appId(1), applicantId(1), 'applicantId', 'nationalId', 'fullName']) {
      check(`roster body never contains "${forbidden.slice(0, 24)}"`, !roster.text.includes(forbidden));
    }
    check('field_supervisor (field.score.sync) → 200', (await get(rosterPath, mint(['field_supervisor']))).status === 200);
    check('reviewer (neither permission) → 403 PERMISSION_DENIED', (await get(rosterPath, mint(['reviewer']))).text.includes('PERMISSION_DENIED'));
    check('no token → 401', (await get(rosterPath)).status === 401);
    check('system token → 403', (await get(rosterPath, mintSystem())).status === 403);
    const rnpRoster = await get(rosterPath, mint(['screening_officer'], 'RNP'));
    const ghostRoster = await get(`/v1/venue-roster?campaign=S04-NOPE&district=GASABO&examDate=${EXAM_DATE}`, mint(['screening_officer'], 'RNP'));
    check("a sibling agency's roster is a bare 404, identical to a nonexistent campaign", rnpRoster.status === 404 && rnpRoster.text === ghostRoster.text, `${rnpRoster.text} vs ${ghostRoster.text}`);
    check('a date with no venue day → 404', (await get(`/v1/venue-roster?campaign=${CODE_OPEN}&district=GASABO&examDate=2026-12-25`, SCREENING)).status === 404);
    check('missing parameters → 400', (await get(`/v1/venue-roster?campaign=${CODE_OPEN}`, SCREENING)).status === 400);
    check('bad district → 400', (await get(`/v1/venue-roster?campaign=${CODE_OPEN}&district=ATLANTIS&examDate=${EXAM_DATE}`, SCREENING)).status === 400);

    console.log('\n── 8. The reads write nothing ──');
    const [writesRow] = await admin<{ writes: string }[]>`
      SELECT (SELECT count(*) FROM public_core.campaign_lifecycle_history WHERE campaign_id = ${C_OPEN})::text AS writes`;
    check('lifecycle history unchanged by reads', writesRow?.writes === '2', String(writesRow?.writes));
  } finally {
    await cleanup();
    await server.stop();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('OPERATIONAL READ MODELS PROVEN (live) ✓');
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
