// ══════════════════════════════════════════════════════════════════
// application-service — Stalled-clearance re-announce sweep, LIVE
//
// Proves against PostgreSQL that an application scheduling deferred (stuck at
// DOCUMENT_REVIEW_GREEN with no slot) is offered to scheduling again:
//   • a stalled row past the grace period is re-announced: one
//     APPLICATION_ELIGIBILITY_CLEARED, staged durably in the outbox, carrying
//     the row's own ids, campaign and category;
//   • the claim is the backoff: an immediate second tick re-announces nothing;
//   • a row inside the grace period, a row that HAS a slot, a row not at GREEN
//     and a row whose campaign was cancelled are never re-announced.
//
//   set -a; . ./.env; set +a
//   pnpm --filter @usrp/application-service exec tsx selfcheck/verify-slot-retry.ts
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import type { USRPEvent } from '@usrp/shared-types';
import { PgStalledClearanceRepository, ReannounceStalledClearancesService } from '../src/index.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

const CITIZEN = 'b9000000-0000-4000-8000-000000000001';
const LIVE = 'b9000000-0000-4000-8000-0000000000c1';
const CANCELLED = 'b9000000-0000-4000-8000-0000000000c2';
const STALLED = 'b9000000-0000-4000-8000-00000000a001';
const FRESH = 'b9000000-0000-4000-8000-00000000a002';
const SLOTTED = 'b9000000-0000-4000-8000-00000000a003';
const VETTING = 'b9000000-0000-4000-8000-00000000a004';
const DEAD_CAMPAIGN = 'b9000000-0000-4000-8000-00000000a005';
const APPS = [STALLED, FRESH, SLOTTED, VETTING, DEAD_CAMPAIGN];
const GRACE_MS = 6 * 60 * 60_000;
const EXAM_DATE = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

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
    await tx`DELETE FROM public_core.event_outbox WHERE payload->>'applicationId' IN ${tx(APPS)}`;
    await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id IN ${tx(APPS)}`;
    await tx`DELETE FROM rdf_ops.applications WHERE id IN ${tx(APPS)}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([LIVE, CANCELLED])}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ${CITIZEN}`;
  });
}

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth, encrypted_home_district,
       encrypted_home_province, gender, registration_channel, identity_status)
      VALUES (${CITIZEN}, ${'b9'.repeat(32)}, 'x','x','x','x','MALE','WEB','VERIFIED'::public_core.identity_verification_status)`;
    await tx`SET LOCAL session_replication_role = replica`;
    for (const [id, code, status] of [[LIVE, 'RDF-RETRY-LIVE', 'REGISTRATION_CLOSED'], [CANCELLED, 'RDF-RETRY-DEAD', 'CANCELLED']] as const) {
      await tx`INSERT INTO public_core.recruitment_campaigns
        (id, public_code, campaign_label, agency, status, target_categories, registration_opens_at,
         registration_closes_at, examination_start_date, examination_end_date, examination_reporting_hour)
        VALUES (${id}, ${code}, ${`Slot retry proof ${code}`}, 'RDF', ${status}::public_core.campaign_status,
                '["GENERAL_ENLISTMENT","RESERVE_FORCE_ALEVEL","RESERVE_FORCE_UNIVERSITY"]',
                now() - interval '10 days', now() - interval '1 day', ${EXAM_DATE}, ${EXAM_DATE}, 8)`;
    }
    const stale = new Date(Date.now() - GRACE_MS - 60_000);
    await tx`INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status, updated_at) VALUES
      (${STALLED}, 'RDF-98501', ${CITIZEN}, ${LIVE}, 'GENERAL_ENLISTMENT', 'DOCUMENT_REVIEW_GREEN', ${stale}),
      (${FRESH}, 'RDF-98502', ${CITIZEN}, ${LIVE}, 'RESERVE_FORCE_ALEVEL', 'DOCUMENT_REVIEW_GREEN', now()),
      (${VETTING}, 'RDF-98504', ${CITIZEN}, ${LIVE}, 'RESERVE_FORCE_UNIVERSITY', 'ACADEMIC_VETTING', ${stale}),
      (${DEAD_CAMPAIGN}, 'RDF-98505', ${CITIZEN}, ${CANCELLED}, 'GENERAL_ENLISTMENT', 'DOCUMENT_REVIEW_GREEN', ${stale})`;
    // GREEN with a slot projected (a lagging status is not a stall).
    await tx`INSERT INTO rdf_ops.applications (id, processing_code, applicant_id, campaign_id, category, status, qr_invitation_code, updated_at)
      VALUES (${SLOTTED}, 'RDF-98503', ${CITIZEN}, ${CANCELLED}, 'RESERVE_FORCE_ALEVEL', 'DOCUMENT_REVIEW_GREEN', 'TKT-RETRY-SLOTTED', ${stale})`;
  });
}

async function main(): Promise<void> {
  console.log('\n══ application-service — stalled-clearance re-announce (LIVE) ══');
  await cleanup();
  await seed();
  const dispatched: USRPEvent[] = [];
  const service = new ReannounceStalledClearancesService({
    repository: new PgStalledClearanceRepository(),
    events: { dispatch: (events): Promise<void> => { dispatched.push(...events); return Promise.resolve(); } },
    policy: { graceMs: GRACE_MS, batchSize: 1000 },
  });
  const ours = (events: readonly USRPEvent[]): USRPEvent[] =>
    events.filter((e) => 'applicationId' in e && APPS.includes(e.applicationId));

  try {
    console.log('\n── 1. A stalled clearance is offered to scheduling again ──');
    await service.sweep();
    const first = ours(dispatched);
    check('exactly one of the fixtures re-announced', first.length === 1, String(first.length));
    const ev = first[0];
    check(
      'it is the stalled row, as APPLICATION_ELIGIBILITY_CLEARED with its own campaign and category',
      ev !== undefined && ev.eventType === 'APPLICATION_ELIGIBILITY_CLEARED' && ev.applicationId === STALLED &&
        ev.applicantId === CITIZEN && ev.agency === 'RDF' && ev.campaignId === LIVE && ev.category === 'GENERAL_ENLISTMENT',
      JSON.stringify(ev),
    );
    const staged = await admin<{ event_id: string; event_type: string }[]>`
      SELECT event_id, event_type FROM public_core.event_outbox WHERE payload->>'applicationId' IN ${admin(APPS)}`;
    check(
      'staged durably in the outbox with the SAME eventId that was dispatched',
      staged.length === 1 && staged[0]?.event_type === 'APPLICATION_ELIGIBILITY_CLEARED' && staged[0]?.event_id === ev?.eventId,
      JSON.stringify(staged),
    );
    const [row] = await admin<{ status: string; touched: boolean }[]>`
      SELECT status::text AS status, updated_at > now() - interval '1 minute' AS touched FROM rdf_ops.applications WHERE id = ${STALLED}`;
    check('the row stays at GREEN (status is scheduling\'s to change) and is marked touched', row?.status === 'DOCUMENT_REVIEW_GREEN' && row.touched === true, JSON.stringify(row));

    console.log('\n── 2. Bounded: the claim is the backoff ──');
    dispatched.length = 0;
    await service.sweep();
    check('an immediate second tick re-announces none of the fixtures', ours(dispatched).length === 0, String(ours(dispatched).length));

    console.log('\n── 3. Never re-announced ──');
    const all = await admin<{ id: string }[]>`
      SELECT payload->>'applicationId' AS id FROM public_core.event_outbox WHERE payload->>'applicationId' IN ${admin(APPS)}`;
    const ids = new Set(all.map((r) => r.id));
    check('a clearance still inside its grace period', !ids.has(FRESH));
    check('a GREEN row that already has a slot', !ids.has(SLOTTED));
    check('a row that is not at GREEN', !ids.has(VETTING));
    check('a row whose campaign was cancelled', !ids.has(DEAD_CAMPAIGN));

    console.log('\n── 4. Still stalled after another grace period → offered again ──');
    dispatched.length = 0;
    await service.sweep(new Date(Date.now() + GRACE_MS + 120_000));
    check('after another grace period the still-stalled row is offered again', ours(dispatched).some((e) => 'applicationId' in e && e.applicationId === STALLED));
  } finally {
    await cleanup();
    await admin.end({ timeout: 5 });
  }

  if (failures > 0) {
    console.error(`\n✗ slot-retry selfcheck FAILED — ${String(failures)} check(s)`);
    process.exit(1);
  }
  console.log('\n✓ slot-retry selfcheck GREEN');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
