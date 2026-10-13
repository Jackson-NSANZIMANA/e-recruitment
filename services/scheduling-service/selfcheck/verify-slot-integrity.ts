// ══════════════════════════════════════════════════════════════════
// scheduling-service — Slot integrity self-check (ADR-026)
//
// Proves against LIVE Postgres that the scheduling gate issues ONE invitation
// per application and never overbooks a venue, whatever the delivery pattern.
// The bus is a controllable double so the broker can be "down" on demand.
//
//   1. First clearance            → ASSIGNED, 1 reservation, 1 seat, staged.
//   2. Redelivered clearance      → ALREADY_ASSIGNED, SAME eventId/ticket/token
//                                   re-announced; no seat, no new outbox row.
//   3. 8 concurrent deliveries    → exactly 1 reservation and 1 seat; every
//                                   outcome carries the same ticket.
//   4. Capacity 2, 5 applicants   → exactly 2 ASSIGNED, 3 NO_CAPACITY, the
//      concurrently                 count is 2 and never overshoots.
//   5. Broker down at assignment  → ASSIGNED, pending outbox, relay delivers.
//   6. No venue                   → NO_VENUE deferral is STAGED (durable).
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   PII_ENCRYPTION_KEY='dev_pii_encryption_key_min_32_chars_ok!!' \
//   npx tsx services/scheduling-service/selfcheck/verify-slot-integrity.ts
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { SlotAssignedEvent, USRPEvent } from '@usrp/shared-types';
import { sql } from '@usrp/shared-database';
import { newCorrelationContext, type EventBus } from '@usrp/shared-events';
import { generateDeviceKeyPair } from '@usrp/shared-security';
import {
  SCHEDULING_OUTBOX_PRODUCER,
  createSchedulingOutboxRelay,
  createSchedulingService,
  loadSchedulingConfig,
  type AssignSlotOutcome,
} from '../src/index.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });
const ENCRYPTION_KEY = process.env['PII_ENCRYPTION_KEY'] ?? 'dev_pii_encryption_key_min_32_chars_ok!!';

const QR_KEYPAIR = generateDeviceKeyPair();
const QR_SIGNING_PRIVATE_KEY_B64 = Buffer.from(QR_KEYPAIR.privateKeyPem, 'utf8').toString('base64');

const CAMPAIGN_ID = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c';
const OPEN_DISTRICT = 'GASABO'; // unbounded venue
const FULL_DISTRICT = 'NYARUGENGE'; // capacity_limit = 2
const NO_VENUE_DISTRICT = 'KIREHE'; // no venue row
const OPEN_APPLICANT = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const FULL_APPLICANT = '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b';
const NO_VENUE_APPLICANT = '5d5d5d5d-5d5d-4d5d-8d5d-5d5d5d5d5d5d';
const CAPACITY = 2;

/** A bus whose broker can be switched off. Records what it actually delivered. */
class FlakyBus implements EventBus {
  down = false;
  readonly published: USRPEvent[] = [];
  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  publish(event: USRPEvent): Promise<void> {
    if (this.down) return Promise.reject(new Error('simulated broker outage'));
    this.published.push(event);
    return Promise.resolve();
  }
  subscribe(): Promise<void> {
    return Promise.resolve();
  }
}

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const touchedApplications: string[] = [];
function newApplicationId(): string {
  const id = randomUUID();
  touchedApplications.push(id);
  return id;
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`DELETE FROM public_core.slot_reservations WHERE campaign_id = ${CAMPAIGN_ID}`;
    await tx`
      DELETE FROM public_core.event_outbox
      WHERE producer = ${SCHEDULING_OUTBOX_PRODUCER}
        AND (payload->>'campaignId' = ${CAMPAIGN_ID} OR payload->'metadata'->>'campaignId' = ${CAMPAIGN_ID})`;
    // Legacy fixture teardown is the documented, test-only superuser escape
    // hatch: production session rows are deactivated, never deleted.
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM public_core.campaign_venue_assignments WHERE campaign_id = ${CAMPAIGN_ID}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN_ID}`;
    await tx`SET LOCAL session_replication_role = origin`;
    await tx`
      DELETE FROM public_core.applicant_identities
      WHERE id IN ${tx([OPEN_APPLICANT, FULL_APPLICANT, NO_VENUE_APPLICANT])}`;
  });
}

async function seedIdentity(id: string, district: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE usrp_system_service`;
    await tx`SELECT set_config('app.encryption_key', ${ENCRYPTION_KEY}, true)`;
    await tx`
      INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
         encrypted_home_district, encrypted_home_province, gender,
         registration_channel, identity_status)
      VALUES (
        ${id}, ${randomUUID().replace(/-/g, '')},
        pgp_sym_encrypt('Integrity Fixture', current_setting('app.encryption_key')),
        pgp_sym_encrypt('2003-03-15',        current_setting('app.encryption_key')),
        pgp_sym_encrypt(${district},         current_setting('app.encryption_key')),
        pgp_sym_encrypt('KIGALI_CITY',       current_setting('app.encryption_key')),
        'MALE'::public_core.gender, 'WEB'::public_core.application_channel,
        'VERIFIED'::public_core.identity_verification_status
      )`;
  });
}

async function seed(): Promise<void> {
  // The reservation proof consumes a migrated legacy campaign/session set;
  // keep fixture creation outside BUILD-001 authoring guards.
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      INSERT INTO public_core.recruitment_campaigns
        (id, public_code, campaign_label, agency, status, target_categories,
         registration_opens_at, registration_closes_at,
         examination_start_date, examination_end_date, examination_reporting_hour)
      VALUES (${CAMPAIGN_ID}, ${`LEGACY-${CAMPAIGN_ID.replaceAll('-', '').toUpperCase()}`},
              ${'SLOT-INTEGRITY-' + randomUUID().slice(0, 8)}, 'RDF', 'REGISTRATION_OPEN',
              '["GENERAL_ENLISTMENT"]', now() - interval '1 day', now() + interval '30 days',
              '2026-12-01','2026-12-15',8)`;
    await tx`
      INSERT INTO public_core.campaign_venue_assignments
        (campaign_id, district, province, venue_name, exam_date, reporting_time_hour, capacity_limit)
      VALUES
        (${CAMPAIGN_ID}, ${OPEN_DISTRICT}, 'KIGALI_CITY', 'Amahoro Stadium', '2026-12-03', 8, NULL),
        (${CAMPAIGN_ID}, ${FULL_DISTRICT}, 'KIGALI_CITY', 'Kigali Pele Stadium', '2026-12-04', 8, ${CAPACITY})`;
  });
  await seedIdentity(OPEN_APPLICANT, OPEN_DISTRICT);
  await seedIdentity(FULL_APPLICANT, FULL_DISTRICT);
  await seedIdentity(NO_VENUE_APPLICANT, NO_VENUE_DISTRICT);
}

async function seatCount(district: string): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT registered_count AS n FROM public_core.campaign_venue_assignments
    WHERE campaign_id = ${CAMPAIGN_ID} AND district = ${district}`;
  return rows[0]?.n ?? -1;
}

async function reservationCount(applicationId: string): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public_core.slot_reservations WHERE application_id = ${applicationId}`;
  return rows[0]?.n ?? -1;
}

interface OutboxRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly published_at: Date | null;
  readonly reason: string | null;
}

async function outboxFor(applicationId: string): Promise<OutboxRow[]> {
  return await admin<OutboxRow[]>`
    SELECT event_id, event_type, published_at, payload->'metadata'->>'reason' AS reason
    FROM public_core.event_outbox
    WHERE producer = ${SCHEDULING_OUTBOX_PRODUCER}
      AND (payload->>'applicationId' = ${applicationId} OR payload->>'entityId' = ${applicationId})
    ORDER BY id`;
}

function ticketOf(outcome: AssignSlotOutcome): string | undefined {
  return outcome.kind === 'ASSIGNED' || outcome.kind === 'ALREADY_ASSIGNED'
    ? outcome.event.qrInvitationCode
    : undefined;
}

async function main(): Promise<void> {
  const config = loadSchedulingConfig({
    DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgresql://usrp_app:app_pw@localhost:5432/usrp_db',
    PII_ENCRYPTION_KEY: ENCRYPTION_KEY,
    QR_SIGNING_PRIVATE_KEY_B64,
    QR_SIGNING_KEY_ID: 'slot-integrity-key-1',
    ...process.env,
  });
  const bus = new FlakyBus();
  const service = createSchedulingService(config, bus).assignSlot;
  const relay = createSchedulingOutboxRelay(bus, { graceMs: 0 });

  const clear = (applicationId: string, applicantId: string) =>
    service.assign({
      applicationId,
      applicantId,
      agency: 'RDF',
      campaignId: CAMPAIGN_ID,
      context: newCorrelationContext(),
    });

  async function drainUntil(done: () => Promise<boolean>, maxTicks = 25): Promise<boolean> {
    for (let i = 0; i < maxTicks; i += 1) {
      await relay.drainOnce();
      if (await done()) return true;
    }
    return false;
  }

  await cleanup();
  await seed();

  try {
    // ── 1. First clearance ─────────────────────────────────────────────
    console.log('\n── 1. First clearance → one reservation, one seat, staged ──');
    const appA = newApplicationId();
    const first = await clear(appA, OPEN_APPLICANT);
    check('ASSIGNED', first.kind === 'ASSIGNED', first.kind);
    if (first.kind !== 'ASSIGNED') throw new Error('cannot continue without a first assignment');
    check('exactly one reservation', (await reservationCount(appA)) === 1);
    check('exactly one seat counted', (await seatCount(OPEN_DISTRICT)) === 1, String(await seatCount(OPEN_DISTRICT)));
    const stagedA = await outboxFor(appA);
    check(
      'SLOT_ASSIGNED + AUDIT_ENTRY staged under scheduling-service',
      stagedA.length === 2 && stagedA[0]?.event_type === 'SLOT_ASSIGNED' && stagedA[1]?.event_type === 'AUDIT_ENTRY',
      stagedA.map((r) => r.event_type).join(','),
    );
    check('staged SLOT_ASSIGNED is the returned event', stagedA[0]?.event_id === first.event.eventId);
    check('fast path delivered it', bus.published.some((e) => e.eventId === first.event.eventId));

    // ── 2. Redelivered clearance ──────────────────────────────────────
    console.log('\n── 2. Redelivered clearance → SAME invitation re-announced ──');
    const publishedBefore = bus.published.length;
    const again = await clear(appA, OPEN_APPLICANT);
    check('ALREADY_ASSIGNED (not a second assignment)', again.kind === 'ALREADY_ASSIGNED', again.kind);
    if (again.kind === 'ALREADY_ASSIGNED') {
      check('same eventId', again.event.eventId === first.event.eventId);
      check('same ticket (qrInvitationCode)', again.event.qrInvitationCode === first.qrInvitationCode);
      check('same signed token', again.event.qrSignedToken === first.qrSignedToken);
    }
    const reannounced = bus.published.slice(publishedBefore) as SlotAssignedEvent[];
    check(
      're-announced exactly the original SLOT_ASSIGNED',
      reannounced.length === 1 && reannounced[0]?.eventId === first.event.eventId,
      String(reannounced.length),
    );
    check('no second seat', (await seatCount(OPEN_DISTRICT)) === 1);
    check('no second reservation', (await reservationCount(appA)) === 1);
    check('no new outbox rows', (await outboxFor(appA)).length === 2);

    // ── 3. Concurrent duplicate deliveries ─────────────────────────────
    console.log('\n── 3. 8 concurrent deliveries of one clearance → one invitation ──');
    const appB = newApplicationId();
    const seatsBefore = await seatCount(OPEN_DISTRICT);
    const racers = await Promise.all(Array.from({ length: 8 }, () => clear(appB, OPEN_APPLICANT)));
    const kinds = racers.map((r) => r.kind);
    check('exactly one ASSIGNED', kinds.filter((k) => k === 'ASSIGNED').length === 1, kinds.join(','));
    check('the rest ALREADY_ASSIGNED', kinds.filter((k) => k === 'ALREADY_ASSIGNED').length === 7, kinds.join(','));
    const tickets = new Set(racers.map(ticketOf));
    check('every outcome carries the SAME ticket', tickets.size === 1 && !tickets.has(undefined), String(tickets.size));
    check('exactly one reservation', (await reservationCount(appB)) === 1);
    check('exactly one seat counted for 8 deliveries', (await seatCount(OPEN_DISTRICT)) === seatsBefore + 1);
    check(
      'exactly one SLOT_ASSIGNED staged',
      (await outboxFor(appB)).filter((r) => r.event_type === 'SLOT_ASSIGNED').length === 1,
    );

    // ── 4. Capacity ─────────────────────────────────────────────────────
    console.log(`\n── 4. Capacity ${CAPACITY}, 5 concurrent applicants → never overbooked ──`);
    const fullApps = Array.from({ length: 5 }, () => newApplicationId());
    const contenders = await Promise.all(fullApps.map((id) => clear(id, FULL_APPLICANT)));
    const assigned = contenders.filter((c) => c.kind === 'ASSIGNED').length;
    const refused = contenders.filter((c) => c.kind === 'NO_CAPACITY');
    check(`exactly ${CAPACITY} ASSIGNED`, assigned === CAPACITY, contenders.map((c) => c.kind).join(','));
    check(`exactly ${5 - CAPACITY} NO_CAPACITY`, refused.length === 5 - CAPACITY);
    check(
      'refusals name VENUE_AT_CAPACITY',
      refused.every((c) => c.kind === 'NO_CAPACITY' && c.reason === 'VENUE_AT_CAPACITY'),
    );
    check('seat count equals capacity (no overshoot)', (await seatCount(FULL_DISTRICT)) === CAPACITY, String(await seatCount(FULL_DISTRICT)));
    let deferralsStaged = 0;
    let refusedReservations = 0;
    for (const [i, c] of contenders.entries()) {
      if (c.kind !== 'NO_CAPACITY') continue;
      const id = fullApps[i] ?? '';
      refusedReservations += await reservationCount(id);
      deferralsStaged += (await outboxFor(id)).filter((r) => r.reason === 'VENUE_AT_CAPACITY').length;
    }
    check('no reservation for a refused applicant', refusedReservations === 0);
    check('every refusal staged a VENUE_AT_CAPACITY deferral audit', deferralsStaged === 5 - CAPACITY, String(deferralsStaged));

    // ── 5. Broker down ──────────────────────────────────────────────────
    console.log('\n── 5. Broker down at assignment → durable, relay delivers ──');
    const appC = newApplicationId();
    bus.down = true;
    const offline = await clear(appC, OPEN_APPLICANT);
    check('still ASSIGNED with the broker down (no throw, no retry into a new ticket)', offline.kind === 'ASSIGNED', offline.kind);
    const pending = await outboxFor(appC);
    check('SLOT_ASSIGNED pending in the outbox', pending[0]?.event_type === 'SLOT_ASSIGNED' && pending[0]?.published_at === null);
    const blocked = await relay.drainOnce();
    check('relay reports blocked while down', blocked.blocked);
    bus.down = false;
    const delivered = await drainUntil(async () => (await outboxFor(appC)).every((r) => r.published_at !== null));
    check('relay delivered SLOT_ASSIGNED + audit after recovery', delivered);
    if (offline.kind === 'ASSIGNED') {
      const copies = bus.published.filter((e) => e.eventId === offline.event.eventId).length;
      check('delivered exactly once', copies === 1, String(copies));
    }

    // ── 6. No venue ─────────────────────────────────────────────────────
    console.log('\n── 6. No venue → deferral staged, nothing reserved ──');
    const appD = newApplicationId();
    const deferred = await clear(appD, NO_VENUE_APPLICANT);
    check('NO_VENUE', deferred.kind === 'NO_VENUE', deferred.kind);
    const deferralRows = await outboxFor(appD);
    check(
      'NO_VENUE_FOR_DISTRICT deferral audit is durable in the outbox',
      deferralRows.length === 1 && deferralRows[0]?.reason === 'NO_VENUE_FOR_DISTRICT',
      JSON.stringify(deferralRows),
    );
    check('no reservation for a deferred application', (await reservationCount(appD)) === 0);
  } finally {
    await cleanup();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('SLOT INTEGRITY PROVEN — ONE INVITATION PER APPLICATION, NO VENUE OVERBOOKED ✓');
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
