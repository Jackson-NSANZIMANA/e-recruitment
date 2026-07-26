// ══════════════════════════════════════════════════════════════════
// identity-service — Live retention-sweep self-check (ADR-019)
//
// Proves storage limitation is mechanical, safe, and gated (owner D7)
// against live infrastructure:
//
//   • DRY-RUN reports exactly the eligible rows — the 13-month-old
//     never-applied identity and the 25-month all-negative-terminal one —
//     and NEVER the controls (fresh identity, active applicant, enlisted
//     ACCEPTED citizen); and it writes NOTHING;
//   • EXECUTE tombstones the two candidates through the SAME gated
//     erasure path as citizen demands (PII → 'ERASED', hash rotated,
//     deleted_at stamped), purges the dead session + consumed challenge
//     past the 30-day grace, and leaves every control AND every live
//     session/challenge untouched;
//   • each tombstone is audited (RETENTION_ERASURE_EXECUTED, agency
//     SYSTEM, class named) — distinct from citizen-demanded erasure;
//   • a second EXECUTE finds nothing: the sweep is idempotent.
//
//   Run (repo root), Tier-1 up + DB bootstrapped:
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/identity-service/selfcheck/verify-retention-sweep-slice.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { sql } from '@usrp/shared-database';
import type { AuditEvent } from '@usrp/shared-types';
import { PgErasureRepository } from '../src/adapters/erasure.pg-repository.js';
import { PgRetentionRepository } from '../src/adapters/retention.pg-repository.js';
import { RetentionSweepService } from '../src/application/retention-sweep.service.js';
import {
  RETENTION_NEGATIVE_TERMINAL_MONTHS,
  RETENTION_NEVER_APPLIED_MONTHS,
  RETENTION_PURGE_GRACE_DAYS,
} from '../src/config.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Deterministic fixtures (ad190000 — unique to this proof) ──────
const SWEEP_A = 'ad190000-0000-4000-8000-000000000001'; // never applied, 13 months old
const SWEEP_B = 'ad190000-0000-4000-8000-000000000002'; // all-negative-terminal, 25 months quiet
const CTRL_FRESH = 'ad190000-0000-4000-8000-000000000003'; // never applied, brand new
const CTRL_ACTIVE = 'ad190000-0000-4000-8000-000000000004'; // has a live SUBMITTED app
const CTRL_ACCEPTED = 'ad190000-0000-4000-8000-000000000005'; // enlisted (ACCEPTED + lock)
const ALL = [SWEEP_A, SWEEP_B, CTRL_FRESH, CTRL_ACTIVE, CTRL_ACCEPTED];
// Five distinct 64-hex NID hashes, one per citizen, all ad19-prefixed.
const HASHES = ['ad19a001', 'ad19b002', 'ad19c003', 'ad19d004', 'ad19e005'].map((p) => p.repeat(8));
const CAMPAIGN = 'ad190000-0000-4000-8000-0000000000c1';
const B_RDF_APP = 'ad190000-0000-4000-8000-00000000a001';
const B_RNP_APP = 'ad190000-0000-4000-8000-00000000a002';
const ACTIVE_APP = 'ad190000-0000-4000-8000-00000000a003';
const ACCEPTED_APP = 'ad190000-0000-4000-8000-00000000a004';
const RNP_CAMPAIGN = 'ad190000-0000-4000-8000-0000000000c2';
const DEAD_SESSION = 'ad19-dead-session-token';
const LIVE_SESSION = 'ad19-live-session-token';
const FULL_NAME_CIPHER = 'ad19-original-cipher'; // any non-'ERASED' marker text

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
    for (const schema of ['rdf_ops', 'rnp_ops', 'rcs_ops'] as const) {
      await tx`
        DELETE FROM ${tx(schema)}.application_status_history
        WHERE application_id IN (SELECT id FROM ${tx(schema)}.applications WHERE applicant_id = ANY(${ALL as string[]}))`;
      await tx`DELETE FROM ${tx(schema)}.applications WHERE applicant_id = ANY(${ALL as string[]})`;
    }
    await tx`DELETE FROM public_core.applicant_sessions WHERE applicant_id = ANY(${ALL as string[]})`;
    await tx`DELETE FROM public_core.applicant_otp_challenges WHERE applicant_id = ANY(${ALL as string[]})`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([CAMPAIGN, RNP_CAMPAIGN])}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ANY(${ALL as string[]})`;
  });
}

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    // Five citizens; ages backdated after insert (replica role bypasses triggers).
    const rows: ReadonlyArray<readonly [string, string]> = [
      [SWEEP_A, HASHES[0] ?? ''],
      [SWEEP_B, HASHES[1] ?? ''],
      [CTRL_FRESH, HASHES[2] ?? ''],
      [CTRL_ACTIVE, HASHES[3] ?? ''],
      [CTRL_ACCEPTED, HASHES[4] ?? ''],
    ];
    for (const [id, hash] of rows) {
      await tx`
        INSERT INTO public_core.applicant_identities
          (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
           encrypted_home_district, encrypted_home_province, gender,
           registration_channel, identity_status)
        VALUES (${id}, ${hash}, ${FULL_NAME_CIPHER}, 'x', 'x', 'x', 'MALE', 'WEB',
                'VERIFIED'::public_core.identity_verification_status)`;
    }
    await tx`
      UPDATE public_core.applicant_identities
      SET created_at = now() - interval '13 months' WHERE id = ${SWEEP_A}`;
    await tx`
      UPDATE public_core.applicant_identities
      SET created_at = now() - interval '26 months'
      WHERE id = ANY(${[SWEEP_B, CTRL_ACTIVE, CTRL_ACCEPTED] as string[]})`;
    // The enlisted control carries the accept-lock (belt for the gate check).
    await tx`
      UPDATE public_core.applicant_identities
      SET cross_agency_locked_at = now() - interval '25 months',
          cross_agency_locked_by_agency = 'RDF', cross_agency_lock_reason = 'ACCEPTED'
      WHERE id = ${CTRL_ACCEPTED}`;

    await tx`
      INSERT INTO public_core.recruitment_campaigns
        (id, campaign_label, agency, status, target_categories,
         registration_opens_at, registration_closes_at,
         examination_start_date, examination_end_date, examination_reporting_hour)
      VALUES
        (${CAMPAIGN}, 'Retention-check RDF', 'RDF', 'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
         now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7),
        (${RNP_CAMPAIGN}, 'Retention-check RNP', 'RNP', 'REGISTRATION_OPEN', '["CADET_OFFICER"]',
         now() - interval '1 day', now() + interval '30 days', '2026-09-01', '2026-09-15', 7)`;

    // SWEEP_B: everything negative-terminal, untouched for 25 months.
    await tx`
      INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
      VALUES (${B_RDF_APP}, 'RDF-99101', ${SWEEP_B}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT',
              'REJECTED'::rdf_ops.application_status)`;
    await tx`
      INSERT INTO rnp_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
      VALUES (${B_RNP_APP}, 'RNP-99101', ${SWEEP_B}, ${RNP_CAMPAIGN}, 'CADET_OFFICER',
              'WITHDRAWN'::rnp_ops.application_status)`;
    await tx`UPDATE rdf_ops.applications SET updated_at = now() - interval '25 months' WHERE id = ${B_RDF_APP}`;
    await tx`UPDATE rnp_ops.applications SET updated_at = now() - interval '25 months' WHERE id = ${B_RNP_APP}`;
    // Controls: one in-flight, one enlisted — both ancient, both immune.
    await tx`
      INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status)
      VALUES
        (${ACTIVE_APP}, 'RDF-99102', ${CTRL_ACTIVE}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT',
         'SUBMITTED'::rdf_ops.application_status),
        (${ACCEPTED_APP}, 'RDF-99103', ${CTRL_ACCEPTED}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT',
         'ACCEPTED'::rdf_ops.application_status)`;
    await tx`
      UPDATE rdf_ops.applications SET updated_at = now() - interval '25 months'
      WHERE id IN ${tx([ACTIVE_APP, ACCEPTED_APP])}`;

    // Session/challenge hygiene fixtures: one long-dead pair, one live pair.
    await tx`
      INSERT INTO public_core.applicant_sessions (applicant_id, session_token, channel, expires_at)
      VALUES
        (${CTRL_ACTIVE}, ${DEAD_SESSION}, 'WEB', now() - interval '40 days'),
        (${CTRL_ACTIVE}, ${LIVE_SESSION}, 'WEB', now() + interval '30 minutes')`;
    await tx`
      INSERT INTO public_core.applicant_otp_challenges (applicant_id, otp_hash, expires_at, consumed_at)
      VALUES
        (${CTRL_ACTIVE}, 'scrypt$dead', now() - interval '40 days', now() - interval '40 days'),
        (${CTRL_ACTIVE}, 'scrypt$live', now() + interval '5 minutes', NULL)`;
  });
}

async function identityState(id: string): Promise<{ deleted: boolean; name: string; hash: string }> {
  const rows = await admin<{ deleted_at: Date | null; encrypted_full_name: string; national_id_hash: string }[]>`
    SELECT deleted_at, encrypted_full_name, national_id_hash
    FROM public_core.applicant_identities WHERE id = ${id}`;
  const row = rows[0];
  return {
    deleted: row?.deleted_at !== null && row?.deleted_at !== undefined,
    name: row?.encrypted_full_name ?? '<missing>',
    hash: row?.national_id_hash ?? '',
  };
}

async function sessionExists(token: string): Promise<boolean> {
  const rows = await admin<{ n: string }[]>`
    SELECT count(*)::text AS n FROM public_core.applicant_sessions WHERE session_token = ${token}`;
  return rows[0]?.n === '1';
}

async function main(): Promise<void> {
  await cleanup();
  await seed();

  const bus = new InMemoryEventBus();
  const sweep = new RetentionSweepService({
    retention: new PgRetentionRepository(),
    erasure: new PgErasureRepository(),
    eventBus: bus,
    policy: {
      neverAppliedMonths: RETENTION_NEVER_APPLIED_MONTHS,
      negativeTerminalMonths: RETENTION_NEGATIVE_TERMINAL_MONTHS,
      purgeGraceDays: RETENTION_PURGE_GRACE_DAYS,
    },
  });

  try {
    console.log('\n── 1. DRY-RUN: exactly the eligible rows, and nothing written ──');
    const report = await sweep.report();
    check('never-applied class contains the 13-month identity', report.neverApplied.includes(SWEEP_A));
    check('…but NOT the fresh one', !report.neverApplied.includes(CTRL_FRESH));
    check('negative-terminal class contains the 25-month one', report.negativeTerminal.includes(SWEEP_B));
    check('…but NOT the active applicant', !report.negativeTerminal.includes(CTRL_ACTIVE));
    check('…and NOT the enlisted (ACCEPTED) citizen', !report.negativeTerminal.includes(CTRL_ACCEPTED));
    check('dead session counted as purgeable', report.purgeableSessions >= 1, String(report.purgeableSessions));
    check('consumed challenge counted as purgeable', report.purgeableChallenges >= 1, String(report.purgeableChallenges));
    const aAfterDry = await identityState(SWEEP_A);
    check('dry-run wrote NOTHING (candidate unerased)', !aAfterDry.deleted && aAfterDry.name === FULL_NAME_CIPHER);
    check('dry-run wrote NOTHING (dead session intact)', await sessionExists(DEAD_SESSION));
    check('dry-run emitted NO audit', bus.published.length === 0, String(bus.published.length));

    console.log('\n── 2. EXECUTE: candidates tombstoned through the gated erasure path ──');
    const result = await sweep.execute();
    check('both candidates erased', result.erased.includes(SWEEP_A) && result.erased.includes(SWEEP_B));
    check('no fixture was gate-skipped', !result.skipped.some((s) => ALL.includes(s.applicantId)), JSON.stringify(result.skipped));
    for (const [label, id] of [['never-applied', SWEEP_A], ['negative-terminal', SWEEP_B]] as const) {
      const state = await identityState(id);
      check(
        `${label}: tombstoned (deleted_at set, PII = 'ERASED', hash rotated)`,
        state.deleted && state.name === 'ERASED' && state.hash.startsWith('e') && !HASHES.includes(state.hash),
        JSON.stringify(state),
      );
    }

    console.log('\n── 3. Controls untouched — the sweep can never overreach ──');
    for (const [label, id] of [
      ['fresh identity', CTRL_FRESH],
      ['active applicant', CTRL_ACTIVE],
      ['enlisted citizen', CTRL_ACCEPTED],
    ] as const) {
      const state = await identityState(id);
      check(`${label} intact`, !state.deleted && state.name === FULL_NAME_CIPHER, JSON.stringify(state));
    }
    const activeApp = await admin<{ status: string }[]>`
      SELECT status::text AS status FROM rdf_ops.applications WHERE id = ${ACTIVE_APP}`;
    check('the in-flight application is still SUBMITTED', activeApp[0]?.status === 'SUBMITTED');

    console.log('\n── 4. Hygiene purge: dead rows go, live rows stay ──');
    check('dead session purged', !(await sessionExists(DEAD_SESSION)));
    check('live session survives', await sessionExists(LIVE_SESSION));
    const challenges = await admin<{ otp_hash: string }[]>`
      SELECT otp_hash FROM public_core.applicant_otp_challenges WHERE applicant_id = ${CTRL_ACTIVE}`;
    check(
      'consumed challenge purged, live one survives',
      challenges.length === 1 && challenges[0]?.otp_hash === 'scrypt$live',
      JSON.stringify(challenges),
    );

    console.log('\n── 5. Audit: one RETENTION_ERASURE_EXECUTED per tombstone, class named ──');
    const audits = bus.published.filter(
      (e): e is AuditEvent => e.eventType === 'AUDIT_ENTRY' && (e as AuditEvent).action === 'RETENTION_ERASURE_EXECUTED',
    );
    const ours = audits.filter((a) => ALL.includes(a.entityId));
    check('exactly TWO retention audits for the fixtures', ours.length === 2, String(ours.length));
    check(
      'never-applied audit: agency SYSTEM, class NEVER_APPLIED, by retention-sweep',
      ours.some(
        (a) => a.entityId === SWEEP_A && a.agency === 'SYSTEM' && a.performedBy === 'retention-sweep' && a.metadata?.['class'] === 'NEVER_APPLIED',
      ),
    );
    check(
      'negative-terminal audit: class NEGATIVE_TERMINAL',
      ours.some((a) => a.entityId === SWEEP_B && a.metadata?.['class'] === 'NEGATIVE_TERMINAL'),
    );
    check('no audit carries any NID hash', !HASHES.some((h) => JSON.stringify(bus.published).includes(h)));

    console.log('\n── 6. Idempotent: a second execute finds nothing of ours ──');
    const again = await sweep.execute();
    check('second run erases none of the fixtures', !again.erased.some((id) => ALL.includes(id)), JSON.stringify(again.erased));
    check(
      'second report lists none of the fixtures',
      !again.report.neverApplied.some((id) => ALL.includes(id)) && !again.report.negativeTerminal.some((id) => ALL.includes(id)),
    );
  } finally {
    await cleanup();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('RETENTION SWEEP PROVEN (live) — gated, dry-run-safe, idempotent, controls untouched ✓');
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
