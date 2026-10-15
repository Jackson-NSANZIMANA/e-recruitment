// ══════════════════════════════════════════════════════════════════
// application-service — Campaign-bound submission proof (BUILD-002)
//
// Proves, against live PostgreSQL, that:
//   • the citizen's chosen PUBLIC campaign code — not "the newest open
//     campaign" — decides which campaign the application belongs to;
//   • the application captures the campaign's policy version and the
//     Kigali evaluation date, and the SAME values ride on the event;
//   • unknown / closed / wrong-agency codes are one NO_OPEN_CAMPAIGN;
//   • the idempotency contract covers the code (same key + other code is a
//     reused key; same key + same code replays);
//   • the binding is WRITE-ONCE: later campaign amendments cannot rewrite it
//     and no UPDATE can change it.
//
//   Run (repo root), Tier-1 up + DB bootstrapped:
//   set -a; . ./.env; set +a
//   pnpm --filter @usrp/application-service exec tsx selfcheck/verify-campaign-bound-submission.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';

const { createApplicationService, loadApplicationConfig } = await import('../src/index.js');
const { kigaliDate } = await import('../src/application/submit-application.service.js');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const A1 = 'b2000000-0000-4000-8000-000000000001';
const A2 = 'b2000000-0000-4000-8000-000000000002';
const APPLICANTS = [A1, A2];
const C_POLICY = 'b2000000-0000-4000-8000-0000000000c1'; // open, HAS a policy version
const C_PLAIN = 'b2000000-0000-4000-8000-0000000000c2'; // open, no policy version
const C_CLOSED = 'b2000000-0000-4000-8000-0000000000c3'; // window already closed
const C_RNP = 'b2000000-0000-4000-8000-0000000000c4'; // other agency
const CAMPAIGNS = [C_POLICY, C_PLAIN, C_CLOSED, C_RNP];
const CODE_POLICY = 'RDF-BOUND-A';
const CODE_PLAIN = 'RDF-BOUND-B';
const CODE_CLOSED = 'RDF-BOUND-C';
const CODE_RNP = 'RNP-BOUND-D';
const POLICY_1 = 'b2000000-0000-4000-8000-0000000000d1';
const POLICY_2 = 'b2000000-0000-4000-8000-0000000000d2';
const OFFICER = 'b2000000-0000-4000-8000-00000000ff01';
const NESA = 'RW2024SC09001';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    const ids = tx(APPLICANTS);
    const apps = await tx<{ id: string }[]>`
      SELECT id FROM rdf_ops.applications WHERE applicant_id IN ${ids}`;
    if (apps.length > 0) {
      const appIds = tx(apps.map((a) => a.id));
      await tx`DELETE FROM public_core.event_outbox
               WHERE payload->>'applicationId' IN ${appIds} OR payload->>'entityId' IN ${appIds}`;
      await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id IN ${appIds}`;
      await tx`DELETE FROM rdf_ops.applications WHERE id IN ${appIds}`;
    }
    await tx`DELETE FROM public_core.event_outbox WHERE payload->>'applicantId' IN ${ids}`;
    await tx`DELETE FROM public_core.submission_requests WHERE applicant_id IN ${ids}`;
    await tx`UPDATE public_core.recruitment_campaigns SET current_policy_version_id = NULL
             WHERE id IN ${tx(CAMPAIGNS)}`;
    await tx`DELETE FROM public_core.campaign_policy_versions WHERE id IN ${tx([POLICY_1, POLICY_2])}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx(CAMPAIGNS)}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${ids}`;
  });
}

async function seed(): Promise<void> {
  const day = 86_400_000;
  const iso = (offsetDays: number): string => new Date(Date.now() + offsetDays * day).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  await admin.begin(async (tx) => {
    for (const [i, id] of APPLICANTS.entries()) {
      const hash = `b2${String(i).padStart(2, '0')}`.repeat(16).slice(0, 64);
      await tx`
        INSERT INTO public_core.applicant_identities
          (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
           encrypted_home_district, encrypted_home_province, gender,
           registration_channel, identity_status)
        VALUES (${id}, ${hash}, 'enc','enc','enc','enc','MALE','WEB','VERIFIED')`;
    }
    // Pre-BUILD-001-shaped fixtures: bypass the authoring triggers like a
    // migrated row would, with explicit public codes.
    await tx`SET LOCAL session_replication_role = replica`;
    const rows: readonly [string, string, string, string, number, number][] = [
      [C_POLICY, CODE_POLICY, 'RDF', 'GENERAL_ENLISTMENT', -1, 30],
      [C_PLAIN, CODE_PLAIN, 'RDF', 'GENERAL_ENLISTMENT', -2, 20],
      [C_CLOSED, CODE_CLOSED, 'RDF', 'GENERAL_ENLISTMENT', -30, -1],
      [C_RNP, CODE_RNP, 'RNP', 'CADET_OFFICER', -1, 30],
    ];
    for (const [id, code, agency, category, opens, closes] of rows) {
      await tx`
        INSERT INTO public_core.recruitment_campaigns
          (id, public_code, campaign_label, agency, status, target_categories,
           registration_opens_at, registration_closes_at, examination_start_date,
           examination_end_date, examination_reporting_hour, allows_walk_in)
        VALUES (${id}, ${code}, ${`BOUND-${code}`}, ${agency}::public_core.agency,
                'REGISTRATION_OPEN', ${`["${category}"]`}, ${iso(opens)}::timestamptz,
                ${iso(closes)}::timestamptz, ${today}, ${today}, 7, false)`;
    }
    for (const [pid, version, hash] of [
      [POLICY_1, 1, 'a'.repeat(64)],
      [POLICY_2, 2, 'b'.repeat(64)],
    ] as const) {
      await tx`
        INSERT INTO public_core.campaign_policy_versions
          (id, campaign_id, agency, version_number, policy_document, policy_hash,
           hash_version, legal_basis_code, legal_basis_reference, created_by)
        VALUES (${pid}, ${C_POLICY}, 'RDF'::public_core.agency, ${version}, '{}'::jsonb,
                ${hash}, 1, 'TEST', 'selfcheck', ${OFFICER})`;
    }
    await tx`UPDATE public_core.recruitment_campaigns
             SET current_policy_version_id = ${POLICY_1} WHERE id = ${C_POLICY}`;
  });
}

interface Row {
  campaign_id: string;
  policy_version_id: string | null;
  evaluation_date: string | null;
}

async function rowFor(applicationId: string): Promise<Row | undefined> {
  const rows = await admin<Row[]>`
    SELECT campaign_id, policy_version_id, evaluation_date::text AS evaluation_date
    FROM rdf_ops.applications WHERE id = ${applicationId}`;
  return rows[0];
}

async function main(): Promise<void> {
  await cleanup();
  await seed();
  const bus = new InMemoryEventBus();
  const app = createApplicationService(loadApplicationConfig(), bus);
  const submit = app.submit;
  const base = { category: 'GENERAL_ENLISTMENT', channel: 'WEB', nesaIndexNumber: NESA } as const;
  const today = kigaliDate(new Date());

  try {
    console.log('\n── 1. The chosen code decides the campaign, and the policy is bound ──');
    const k1 = crypto.randomUUID();
    const a = await submit.submit({ applicantId: A1, ...base, campaignCode: CODE_POLICY, idempotencyKey: k1 });
    check('code A → SUBMITTED', a.kind === 'SUBMITTED', JSON.stringify(a));
    if (a.kind !== 'SUBMITTED') throw new Error('setup failed');
    const rowA = await rowFor(a.applicationId);
    check('filed under campaign A (not "the newest open one")', rowA?.campaign_id === C_POLICY, rowA?.campaign_id);
    check('policy_version_id = the campaign’s policy at filing', rowA?.policy_version_id === POLICY_1, String(rowA?.policy_version_id));
    check('evaluation_date = today in Africa/Kigali', rowA?.evaluation_date === today, `${String(rowA?.evaluation_date)} vs ${today}`);
    check('the event carries the same referenceDate + policyVersionId',
      a.event.referenceDate === today && a.event.policyVersionId === POLICY_1);
    const staged = await admin<{ payload: { referenceDate?: string; policyVersionId?: string } }[]>`
      SELECT payload FROM public_core.event_outbox
      WHERE event_type = 'APPLICANT_SUBMITTED' AND payload->>'applicationId' = ${a.applicationId}`;
    check('…and so does the durable outbox row', staged[0]?.payload.referenceDate === today && staged[0]?.payload.policyVersionId === POLICY_1);

    console.log('\n── 2. The same citizen, another campaign: independent, no policy ──');
    const b = await submit.submit({ applicantId: A1, ...base, campaignCode: CODE_PLAIN, idempotencyKey: crypto.randomUUID() });
    check('code B → SUBMITTED (different campaign, same category)', b.kind === 'SUBMITTED', JSON.stringify(b));
    if (b.kind === 'SUBMITTED') {
      const rowB = await rowFor(b.applicationId);
      check('filed under campaign B', rowB?.campaign_id === C_PLAIN);
      check('no policy version → null, never invented', rowB?.policy_version_id === null && rowB?.evaluation_date === today);
    }

    console.log('\n── 3. Unknown / closed / wrong-agency codes are one answer ──');
    for (const [label, code] of [
      ['unknown code', 'RDF-NOPE-9'],
      ['registration window closed', CODE_CLOSED],
      ['other agency’s campaign', CODE_RNP],
    ] as const) {
      const r = await submit.submit({ applicantId: A2, ...base, campaignCode: code, idempotencyKey: crypto.randomUUID() });
      check(`${label} → NO_OPEN_CAMPAIGN`, r.kind === 'NO_OPEN_CAMPAIGN', r.kind);
    }
    const none = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM rdf_ops.applications WHERE applicant_id = ${A2}`;
    check('…and nothing was filed for them', none[0]?.n === 0);

    console.log('\n── 4. The idempotency contract covers the code ──');
    const replay = await submit.submit({ applicantId: A1, ...base, campaignCode: CODE_POLICY, idempotencyKey: k1 });
    check('same key + same code → REPLAYED, same application',
      replay.kind === 'REPLAYED' && replay.applicationId === a.applicationId, replay.kind);
    const reused = await submit.submit({ applicantId: A1, ...base, campaignCode: CODE_PLAIN, idempotencyKey: k1 });
    check('same key + a DIFFERENT code → KEY_REUSED', reused.kind === 'KEY_REUSED', reused.kind);

    console.log('\n── 5. The binding is write-once ──');
    await admin`UPDATE public_core.recruitment_campaigns SET current_policy_version_id = ${POLICY_2} WHERE id = ${C_POLICY}`.catch(() => undefined);
    const afterAmend = await rowFor(a.applicationId);
    check('amending the campaign does not rewrite the application', afterAmend?.policy_version_id === POLICY_1);
    let blocked = 0;
    for (const change of [
      (): Promise<unknown> => admin`UPDATE rdf_ops.applications SET policy_version_id = ${POLICY_2} WHERE id = ${a.applicationId}`,
      (): Promise<unknown> => admin`UPDATE rdf_ops.applications SET evaluation_date = '2000-01-01' WHERE id = ${a.applicationId}`,
    ]) {
      try {
        await change();
      } catch (err) {
        if ((err as { code?: string }).code === '23514') blocked += 1;
      }
    }
    check('UPDATE of policy_version_id / evaluation_date is refused by the engine (even as admin)', blocked === 2, `blocked ${String(blocked)}/2`);

    console.log('\n── 6. The legacy path (no code) still resolves ──');
    const legacy = await submit.submit({ applicantId: A2, ...base, idempotencyKey: crypto.randomUUID() });
    check('no code → legacy resolution still files', legacy.kind === 'SUBMITTED', legacy.kind);
  } finally {
    await cleanup();
    await admin.end();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('CAMPAIGN-BOUND SUBMISSION PROVEN (live) ✓');
  else {
    console.error(`${String(failures)} assertion(s) FAILED`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('SELF-CHECK CRASHED:', err);
  process.exit(1);
});
