// ══════════════════════════════════════════════════════════════════
// application-service — Transactional outbox self-check (ADR-025)
//
// Proves against LIVE Postgres that a committed state change can no longer
// lose its event. The bus is a controllable double so the broker can be
// "down" at exactly the moment the old code lost events:
//
//   1. Front door with the broker DOWN → the citizen still gets SUBMITTED,
//      the application row AND its APPLICANT_SUBMITTED outbox row commit.
//   2. Relay while still down → blocked, attempt + error recorded, nothing
//      lost. Broker back → delivered exactly once; a second drain is a no-op.
//   3. Atomicity → staging a duplicate event aborts the WHOLE transaction:
//      no application row survives without its announcement.
//   4. THE lost-CLEARED defect → the projection reaches GREEN while the
//      broker is down; the redelivered verdict is NO_CHANGE (the exact path
//      that used to drop CLEARED forever); the relay still delivers CLEARED.
//
//   DATABASE_URL='postgresql://usrp_app:app_pw@localhost:5432/usrp_db' \
//   npx tsx services/application-service/selfcheck/verify-outbox-slice.ts
// ══════════════════════════════════════════════════════════════════

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { USRPEvent } from '@usrp/shared-types';
import { sql } from '@usrp/shared-database';
import { newCorrelationContext, type EventBus } from '@usrp/shared-events';
import {
  PgApplicationRepository,
  PgOutboxRelay,
  createApplicationService,
  loadApplicationConfig,
  type CreateApplicationInput,
  type VettingResult,
} from '../src/index.js';

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ??
  'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// Config needs a verify key; this proof drives the use cases directly.
if (process.env['AUTH_JWT_PUBLIC_KEY_B64'] === undefined) {
  const authKey = generateKeyPairSync('ed25519');
  process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
    authKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    'utf8',
  ).toString('base64');
}

const APPLICANT_ID = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const NID_HASH = 'c0ffee00'.repeat(8);
const CAMPAIGN_ID = '8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c8c';

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

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    // Status history is append-only for every role (0007); the documented
    // superuser escape hatch disables triggers for this maintenance tx only.
    await tx`SET LOCAL session_replication_role = replica`;
    const apps = await tx<{ id: string }[]>`SELECT id FROM rdf_ops.applications WHERE applicant_id = ${APPLICANT_ID}`;
    const ids = apps.map((a) => a.id);
    await tx`DELETE FROM public_core.event_outbox WHERE payload->>'applicantId' = ${APPLICANT_ID}`;
    if (ids.length > 0) {
      await tx`
        DELETE FROM public_core.event_outbox
        WHERE payload->>'entityId' IN ${tx(ids)} OR payload->>'applicationId' IN ${tx(ids)}`;
      await tx`DELETE FROM rdf_ops.application_status_history WHERE application_id IN ${tx(ids)}`;
      await tx`DELETE FROM rdf_ops.applications WHERE id IN ${tx(ids)}`;
    }
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id = ${CAMPAIGN_ID}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id = ${APPLICANT_ID}`;
  });
}

async function seed(): Promise<void> {
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status)
    VALUES (${APPLICANT_ID}, ${NID_HASH}, 'x','x','x','x','MALE','WEB',
            'VERIFIED'::public_core.identity_verification_status)`;
  await admin`
    INSERT INTO public_core.recruitment_campaigns
      (id, campaign_label, agency, status, target_categories,
       registration_opens_at, registration_closes_at,
       examination_start_date, examination_end_date, examination_reporting_hour)
    VALUES
      (${CAMPAIGN_ID}, 'Outbox RDF', 'RDF', 'REGISTRATION_OPEN',
       '["GENERAL_ENLISTMENT"]',
       now() - interval '1 day', now() + interval '30 days', '2026-09-01','2026-09-15',7)`;
}

interface OutboxRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly published_at: Date | null;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly application_id: string | null;
}

async function outboxRow(eventId: string): Promise<OutboxRow | undefined> {
  const rows = await admin<OutboxRow[]>`
    SELECT event_id, event_type, published_at, attempts, last_error,
           payload->>'applicationId' AS application_id
    FROM public_core.event_outbox WHERE event_id = ${eventId}`;
  return rows[0];
}

async function outboxFor(applicationId: string, eventType: string): Promise<OutboxRow[]> {
  return await admin<OutboxRow[]>`
    SELECT event_id, event_type, published_at, attempts, last_error,
           payload->>'applicationId' AS application_id
    FROM public_core.event_outbox
    WHERE event_type = ${eventType}
      AND (payload->>'applicationId' = ${applicationId} OR payload->>'entityId' = ${applicationId})
    ORDER BY id`;
}

async function applicationCount(): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rdf_ops.applications WHERE applicant_id = ${APPLICANT_ID}`;
  return rows[0]?.n ?? -1;
}

function age(applicationId: string): VettingResult {
  return {
    dimension: 'AGE',
    applicationId,
    agency: 'RDF',
    ageStatus: 'ELIGIBLE',
    detail: { eligible: true, ageAtEvaluation: 22, appliedMaxAge: 25, reason: 'within age band' },
    correlationId: randomUUID(),
  };
}
function nesa(applicationId: string): VettingResult {
  return {
    dimension: 'ACADEMIC',
    applicationId,
    agency: 'RDF',
    academicStatus: 'ELIGIBLE',
    verifiedVia: 'NESA',
    requestId: randomUUID(),
    detail: { eligible: true },
    correlationId: randomUUID(),
  };
}
function rib(applicationId: string): VettingResult {
  return {
    dimension: 'CRIMINAL',
    applicationId,
    agency: 'RDF',
    criminalStatus: 'CLEARED',
    appliedThreshold: 'ANY_CONVICTION',
    ribRequestId: randomUUID(),
    correlationId: randomUUID(),
  };
}

async function main(): Promise<void> {
  const config = loadApplicationConfig();
  const bus = new FlakyBus();
  const service = createApplicationService(config, bus);
  // graceMs 0: drain deterministically instead of waiting out the fast-path window.
  const relay = new PgOutboxRelay(bus, { graceMs: 0 });
  const repo = new PgApplicationRepository();

  /** Drain until `done` holds (other proofs may have left a backlog ahead of us). */
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
    // ── 1. Front door while the broker is down ───────────────────────────
    console.log('\n── 1. Submission commits WITH its event while the broker is down ──');
    bus.down = true;
    const outcome = await service.submit({
      applicantId: APPLICANT_ID,
      category: 'GENERAL_ENLISTMENT',
      channel: 'WEB',
      nesaIndexNumber: 'RW2024SC07777',
    });
    check('citizen still gets SUBMITTED (no 500 for a filed application)', outcome.kind === 'SUBMITTED', outcome.kind);
    if (outcome.kind !== 'SUBMITTED') throw new Error('cannot continue without a submission');
    const submittedId = outcome.event.eventId;

    const appRows = await admin<{ status: string }[]>`
      SELECT status::text AS status FROM rdf_ops.applications WHERE id = ${outcome.applicationId}`;
    check('application row committed', appRows[0]?.status === 'SUBMITTED', String(appRows[0]?.status));
    const staged = await outboxRow(submittedId);
    check('APPLICANT_SUBMITTED staged in the outbox', staged?.event_type === 'APPLICANT_SUBMITTED', String(staged?.event_type));
    check('staged event is bound to the created application', staged?.application_id === outcome.applicationId);
    check('staged event is pending (the fast path failed)', staged !== undefined && staged.published_at === null);
    check('the broker received nothing', !bus.published.some((e) => e.eventId === submittedId));

    // ── 2. Relay: blocked while down, exactly-once after recovery ──────────
    console.log('\n── 2. Relay holds the line, then delivers exactly once ────────────');
    const blocked = await relay.drainOnce();
    check('relay reports blocked while the broker is down', blocked.blocked);
    // Our row may sit behind another proof's leftover backlog; the attempt is
    // recorded on whichever row the relay stopped at, so assert on ours only
    // once it is reached.
    bus.down = false;
    const delivered = await drainUntil(async () => (await outboxRow(submittedId))?.published_at != null);
    check('relay delivered APPLICANT_SUBMITTED after recovery', delivered);
    const countSubmitted = (): number => bus.published.filter((e) => e.eventId === submittedId).length;
    check('delivered exactly once', countSubmitted() === 1, String(countSubmitted()));
    await relay.drainOnce();
    check('a further drain republishes nothing', countSubmitted() === 1, String(countSubmitted()));
    const stamped = await outboxRow(submittedId);
    check('attempts recorded on the delivered row', (stamped?.attempts ?? 0) >= 1, String(stamped?.attempts));

    // Record a failure on a row we own, deterministically: block, then inspect.
    bus.down = true;
    const failingInput: CreateApplicationInput = {
      agency: 'RDF',
      applicantId: APPLICANT_ID,
      campaignId: CAMPAIGN_ID,
      category: 'GENERAL_ENLISTMENT',
      channel: 'WEB',
      nesaIndexNumber: null,
      hecRegistrationNumber: null,
      correlationId: randomUUID(),
    };
    const second = await service.submit({ applicantId: APPLICANT_ID, category: 'GENERAL_ENLISTMENT', channel: 'WEB', nesaIndexNumber: 'RW2024SC07778' });
    if (second.kind === 'SUBMITTED') {
      await relay.drainOnce();
      const failed = await outboxRow(second.event.eventId);
      check('a failed relay attempt is recorded with its error', (failed?.attempts ?? 0) >= 1 && failed?.last_error != null, JSON.stringify(failed));
      check('a failed relay attempt leaves the row pending', failed !== undefined && failed.published_at === null);
    } else {
      check('second submission accepted', false, second.kind);
    }
    bus.down = false;
    await drainUntil(async () => second.kind !== 'SUBMITTED' || (await outboxRow(second.event.eventId))?.published_at != null);

    // ── 3. Atomicity: the outbox write is IN the state transaction ──────────
    console.log('\n── 3. A failed stage rolls the whole filing back ──────────────────');
    const before = await applicationCount();
    let threw = false;
    try {
      // Re-staging an already-staged envelope violates event_outbox's UNIQUE.
      await repo.createApplication(failingInput, () => [outcome.event]);
    } catch {
      threw = true;
    }
    check('duplicate staged event aborts the transaction', threw);
    const after = await applicationCount();
    check('no application row survives without its announcement', after === before, `${before}→${after}`);

    // ── 4. The lost-CLEARED defect, reproduced and closed ─────────────────
    console.log('\n── 4. GREEN while the broker is down: CLEARED is still delivered ────');
    const { applicationId } = await repo.createApplication({ ...failingInput, correlationId: randomUUID() });
    await service.projector.project({ result: age(applicationId), agency: 'RDF', context: newCorrelationContext() });
    await service.projector.project({ result: nesa(applicationId), agency: 'RDF', context: newCorrelationContext() });

    bus.down = true;
    const green = await service.projector.project({ result: rib(applicationId), agency: 'RDF', context: newCorrelationContext() });
    check(
      'projection reached DOCUMENT_REVIEW_GREEN with the broker down',
      green.kind === 'APPLIED' && green.toStatus === 'DOCUMENT_REVIEW_GREEN',
      JSON.stringify(green),
    );
    const statusRows = await admin<{ status: string }[]>`
      SELECT status::text AS status FROM rdf_ops.applications WHERE id = ${applicationId}`;
    check('GREEN is committed', statusRows[0]?.status === 'DOCUMENT_REVIEW_GREEN', String(statusRows[0]?.status));
    const clearedStaged = await outboxFor(applicationId, 'APPLICATION_ELIGIBILITY_CLEARED');
    check('CLEARED staged exactly once, in the GREEN transaction', clearedStaged.length === 1, String(clearedStaged.length));
    check('CLEARED is pending (fast path failed)', clearedStaged[0]?.published_at === null);
    check(
      'the broker never saw CLEARED',
      !bus.published.some((e) => e.eventType === 'APPLICATION_ELIGIBILITY_CLEARED' && e.applicationId === applicationId),
    );

    const redelivered = await service.projector.project({ result: rib(applicationId), agency: 'RDF', context: newCorrelationContext() });
    check('redelivered verdict is NO_CHANGE — the path that used to drop CLEARED forever', redelivered.kind === 'NO_CHANGE', redelivered.kind);
    check('redelivery staged no second CLEARED', (await outboxFor(applicationId, 'APPLICATION_ELIGIBILITY_CLEARED')).length === 1);

    bus.down = false;
    const clearedDelivered = await drainUntil(async () => (await outboxFor(applicationId, 'APPLICATION_ELIGIBILITY_CLEARED'))[0]?.published_at != null);
    check('relay delivered CLEARED after recovery — scheduling WILL hear about it', clearedDelivered);
    const clearedCount = bus.published.filter(
      (e) => e.eventType === 'APPLICATION_ELIGIBILITY_CLEARED' && e.applicationId === applicationId,
    ).length;
    check('CLEARED delivered exactly once', clearedCount === 1, String(clearedCount));
    const audits = await outboxFor(applicationId, 'AUDIT_ENTRY');
    check('every audit entry for the transitions was staged (age, nesa, rib)', audits.length === 3, String(audits.length));
  } finally {
    await cleanup();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('TRANSACTIONAL OUTBOX PROVEN — NO COMMITTED TRANSITION LOSES ITS EVENT ✓');
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
