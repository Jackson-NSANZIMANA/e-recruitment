// ══════════════════════════════════════════════════════════════════
// background-vetting-service — Live self-check (stage 3: criminal clearance)
//
// Proves the RIB criminal-clearance gate end-to-end, four ways:
//
//   1. PURE POLICY — evaluateCriminalClearance over every category × RIB
//      status: CLEAR→CLEARED, UNDER_INVESTIGATION→UNDER_REVIEW,
//      HAS_RECORDS→FLAGGED_CONVICTION (ANY_CONVICTION agencies) or
//      UNDER_REVIEW (RNP sentence-length agencies). No I/O.
//
//   2. LIVE RIB GATEWAY — the real HTTP adapter against usrp-rib-mock:3102,
//      HMAC-signed, resolving the three record states from the mock's data.
//
//   3. EVENT-DRIVEN e2e over LIVE Kafka:
//        publish APPLICANT_SUBMITTED ─► [vetting consumer] ─► RIB gate
//              (applicant.submitted)              │
//                            ┌────────────────────┴───────────────────┐
//                            ▼                                         ▼
//        RIB_VETTING_COMPLETED on vetting.rib         AUDIT_ENTRY on audit.immutable
//        (clearanceStatus, appliedThreshold)          (correlationId preserved,
//                                                      causationId = trigger id)
//      Three submissions prove the three decisive verdicts: FLAGGED_CONVICTION
//      (RDF + records), CLEARED (RDF + clean), UNDER_REVIEW (RNP + records).
//      No raw NID / nationalIdHash leaks into either event.
//
//   4. FAIL-CLOSED — an unreachable RIB raises RibUnavailableError (never a
//      fabricated clearance).
//
// DB-free: this gate keys off the nationalIdHash carried in the event, so the
// check seeds no Postgres fixture. Requires tier1 RIB mock (:3102) + tier2
// Kafka (host listener :29092).
//
//   RIB_BASE_URL='http://localhost:3102' RIB_HMAC_SECRET='dev_rib_hmac_secret' \
//   KAFKA_BROKERS='localhost:29092' \
//   pnpm --filter @usrp/background-vetting-service selfcheck
// ══════════════════════════════════════════════════════════════════

import { randomUUID, randomBytes } from 'node:crypto';
import type {
  ApplicantSubmittedEvent,
  ApplicationCategory,
  AuditEvent,
  RIBVettingCompletedEvent,
} from '@usrp/shared-types';
import { KafkaEventBus, newCorrelationContext, newEnvelope } from '@usrp/shared-events';
import {
  RibHttpGateway,
  RibUnavailableError,
  createBackgroundVettingService,
  evaluateCriminalClearance,
  loadBackgroundVettingConfig,
  startApplicantSubmittedConsumer,
} from '../src/index.js';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(',');

// From infrastructure/docker/mocks/rib/data/records.json — the mock's fixtures.
const FLAGGED_HASH = '6709cb62a5872432d0126af9f6abc92922d1e5fc0e8de58168a8ecb58159c2b5';
const UNDER_INVESTIGATION_HASH = '9f15bc15a8765bf059d71626d80fc1a879d55e193793db0e2ad94d331c87a291';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── One event-driven scenario: a submission and the verdict we expect ──
interface Scenario {
  readonly name: string;
  readonly applicationId: string;
  readonly nationalIdHash: string;
  readonly category: ApplicationCategory;
  readonly agency: 'RDF' | 'RNP' | 'RCS';
  readonly expectedClearance: string;
  readonly expectedThreshold: string;
  readonly expectedCleared: boolean;
  readonly expectedAction: string;
}

async function main(): Promise<void> {
  const config = loadBackgroundVettingConfig({
    RIB_BASE_URL: 'http://localhost:3102',
    RIB_HMAC_SECRET: 'dev_rib_hmac_secret',
    ...process.env,
  });

  // ── 1. Pure policy ────────────────────────────────────────────────
  console.log('\n── 1. Pure criminal-clearance policy ────────────────────────');
  {
    const rdf = evaluateCriminalClearance('GENERAL_ENLISTMENT', 'CLEAR');
    check('RDF + CLEAR → CLEARED, cleared', rdf.clearanceStatus === 'CLEARED' && rdf.cleared);
    check('RDF applies ANY_CONVICTION', rdf.appliedThreshold === 'ANY_CONVICTION');

    const rdfRec = evaluateCriminalClearance('GENERAL_ENLISTMENT', 'HAS_RECORDS');
    check(
      'RDF + HAS_RECORDS → FLAGGED_CONVICTION, not cleared',
      rdfRec.clearanceStatus === 'FLAGGED_CONVICTION' && !rdfRec.cleared,
      rdfRec.clearanceStatus,
    );

    const rcsRec = evaluateCriminalClearance('OFFICER_FOUR_YEAR_UR', 'HAS_RECORDS');
    check(
      'RCS + HAS_RECORDS → FLAGGED_CONVICTION (ANY_CONVICTION)',
      rcsRec.clearanceStatus === 'FLAGGED_CONVICTION' && rcsRec.appliedThreshold === 'ANY_CONVICTION',
      rcsRec.clearanceStatus,
    );

    const rnpCadet = evaluateCriminalClearance('CADET_OFFICER', 'HAS_RECORDS');
    check(
      'RNP Cadet + HAS_RECORDS → UNDER_REVIEW (coarse flag, >6mo rule)',
      rnpCadet.clearanceStatus === 'UNDER_REVIEW' && !rnpCadet.cleared,
      rnpCadet.clearanceStatus,
    );
    check('RNP Cadet applies IMPRISONMENT_GT_6MO', rnpCadet.appliedThreshold === 'IMPRISONMENT_GT_6MO');

    const rnpBasic = evaluateCriminalClearance('BASIC_POLICE_COURSE', 'HAS_RECORDS');
    check('RNP Basic applies IMPRISONMENT_GTE_6MO', rnpBasic.appliedThreshold === 'IMPRISONMENT_GTE_6MO');

    const inv = evaluateCriminalClearance('GENERAL_ENLISTMENT', 'UNDER_INVESTIGATION');
    check(
      'UNDER_INVESTIGATION → UNDER_REVIEW for any agency',
      inv.clearanceStatus === 'UNDER_REVIEW' && !inv.cleared,
      inv.clearanceStatus,
    );
  }

  // ── 2. Live RIB gateway against the mock ──────────────────────────
  console.log('\n── 2. Live RIB gateway (usrp-rib-mock:3102) ─────────────────');
  {
    const gateway = new RibHttpGateway({
      baseUrl: config.rib.baseUrl,
      hmacSecret: config.rib.hmacSecret,
      timeoutMs: config.rib.timeoutMs,
    });

    const clean = await gateway.checkVetting(randomBytes(32).toString('hex'));
    check('unknown hash → CLEAR', clean.status === 'CLEAR', clean.status);
    check('gateway returns a ribRequestId', typeof clean.ribRequestId === 'string' && clean.ribRequestId.length > 0);

    const flagged = await gateway.checkVetting(FLAGGED_HASH);
    check('flagged hash → HAS_RECORDS', flagged.status === 'HAS_RECORDS', flagged.status);

    const investigated = await gateway.checkVetting(UNDER_INVESTIGATION_HASH);
    check('investigation hash → UNDER_INVESTIGATION', investigated.status === 'UNDER_INVESTIGATION', investigated.status);
  }

  // ── 3. Event-driven e2e over live Kafka ───────────────────────────
  console.log('\n── 3. Event-driven vetting over live Kafka ──────────────────');

  const scenarios: Scenario[] = [
    {
      name: 'RDF + records → FLAGGED_CONVICTION',
      applicationId: randomUUID(),
      nationalIdHash: FLAGGED_HASH,
      category: 'GENERAL_ENLISTMENT',
      agency: 'RDF',
      expectedClearance: 'FLAGGED_CONVICTION',
      expectedThreshold: 'ANY_CONVICTION',
      expectedCleared: false,
      expectedAction: 'CRIMINAL_CLEARANCE_FLAGGED',
    },
    {
      name: 'RDF + clean → CLEARED',
      applicationId: randomUUID(),
      nationalIdHash: randomBytes(32).toString('hex'),
      category: 'GENERAL_ENLISTMENT',
      agency: 'RDF',
      expectedClearance: 'CLEARED',
      expectedThreshold: 'ANY_CONVICTION',
      expectedCleared: true,
      expectedAction: 'CRIMINAL_CLEARANCE_PASSED',
    },
    {
      name: 'RNP Cadet + records → UNDER_REVIEW',
      applicationId: randomUUID(),
      nationalIdHash: FLAGGED_HASH,
      category: 'CADET_OFFICER',
      agency: 'RNP',
      expectedClearance: 'UNDER_REVIEW',
      expectedThreshold: 'IMPRISONMENT_GT_6MO',
      expectedCleared: false,
      expectedAction: 'CRIMINAL_CLEARANCE_FLAGGED',
    },
  ];
  const byApplication = new Map(scenarios.map((s) => [s.applicationId, s]));

  // The service's own bus: consumes applicant.submitted AND publishes its
  // RIB_VETTING_COMPLETED + AUDIT_ENTRY — all to real Kafka.
  const serviceBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'background-vetting-service' });
  const service = createBackgroundVettingService(config, serviceBus).criminalClearance;

  // Independent observers of the two output topics — how we SEE the reaction.
  const ribBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-rib-observer' });
  const auditBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-audit-observer' });
  const producerBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-producer' });

  const ribSeen = new Map<string, RIBVettingCompletedEvent>();
  const auditSeen = new Map<string, AuditEvent>();
  let resolveAll: () => void;
  const allSeen = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  const maybeDone = (): void => {
    if (ribSeen.size === scenarios.length && auditSeen.size === scenarios.length) resolveAll();
  };

  await ribBus.subscribe(['vetting.rib'], `selfcheck-rib-${randomUUID()}`, (event) => {
    if (event.eventType === 'RIB_VETTING_COMPLETED' && byApplication.has(event.applicationId)) {
      ribSeen.set(event.applicationId, event);
      maybeDone();
    }
  });
  await auditBus.subscribe(['audit.immutable'], `selfcheck-audit-${randomUUID()}`, (event) => {
    if (event.eventType === 'AUDIT_ENTRY' && byApplication.has(event.entityId)) {
      auditSeen.set(event.entityId, event);
      maybeDone();
    }
  });

  // Start the real vetting consumer on applicant.submitted.
  await startApplicantSubmittedConsumer(serviceBus, service);
  // Let every consumer group get its partition assignment before publishing.
  await new Promise((r) => setTimeout(r, 5000));

  const triggers = new Map<string, ApplicantSubmittedEvent>();
  for (const s of scenarios) {
    const submitted: ApplicantSubmittedEvent = {
      ...newEnvelope(newCorrelationContext()),
      eventType: 'APPLICANT_SUBMITTED',
      applicantId: randomUUID(),
      applicationId: s.applicationId,
      nationalIdHash: s.nationalIdHash,
      agency: s.agency,
      category: s.category,
      channel: 'WEB',
      nesaIndexNumber: null,
      hecRegistrationNumber: null,
    };
    triggers.set(s.applicationId, submitted);
    await producerBus.publish(submitted);
    console.log(`  → published APPLICANT_SUBMITTED [${s.name}] correlationId=${submitted.correlationId}`);
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timed out after 30s waiting for RIB + audit reactions')), 30_000),
  );
  await Promise.race([allSeen, timeout]);

  console.log('\n── The reactions arrived over the backbone ──────────────────');
  for (const s of scenarios) {
    const rib = ribSeen.get(s.applicationId);
    const audit = auditSeen.get(s.applicationId);
    const trigger = triggers.get(s.applicationId)!;
    console.log(`\n  [${s.name}]`);

    check('RIB_VETTING_COMPLETED observed', rib !== undefined);
    check('AUDIT_ENTRY observed', audit !== undefined);
    if (!rib || !audit) continue;

    check('clearanceStatus as expected', rib.clearanceStatus === s.expectedClearance, `${rib.clearanceStatus} vs ${s.expectedClearance}`);
    check('appliedThreshold as expected', rib.appliedThreshold === s.expectedThreshold, `${rib.appliedThreshold} vs ${s.expectedThreshold}`);
    check('agency derived from category', rib.agency === s.agency, String(rib.agency));
    check('applicationId bound', rib.applicationId === s.applicationId);
    check('rib correlationId preserved from trigger', rib.correlationId === trigger.correlationId);
    check('rib causationId === trigger eventId (causal chain)', rib.causationId === trigger.eventId, `${rib.causationId} vs ${trigger.eventId}`);

    check('audit action as expected', audit.action === s.expectedAction, audit.action);
    check('audit performedBy is background-vetting-service', audit.performedBy === 'background-vetting-service');
    check('audit agency attributed', audit.agency === s.agency, String(audit.agency));
    check('audit correlationId preserved', audit.correlationId === trigger.correlationId);
    const meta = audit.metadata ?? {};
    check('audit metadata.cleared as expected', meta['cleared'] === s.expectedCleared, String(meta['cleared']));
    check('audit metadata.appliedThreshold recorded', meta['appliedThreshold'] === s.expectedThreshold);

    // No raw NID / nationalIdHash leaks into either output event.
    const ribJson = JSON.stringify(rib);
    const auditJson = JSON.stringify(audit);
    check('nationalIdHash absent from RIB_VETTING_COMPLETED', !ribJson.includes(s.nationalIdHash));
    check('nationalIdHash absent from AUDIT_ENTRY', !auditJson.includes(s.nationalIdHash));
  }

  // ── 4. Fail-closed on an unreachable RIB ──────────────────────────
  console.log('\n── 4. Fail-closed: RIB unreachable ──────────────────────────');
  {
    const deadGateway = new RibHttpGateway({
      baseUrl: 'http://localhost:1', // nothing listening
      hmacSecret: 'dev_rib_hmac_secret',
      timeoutMs: 1500,
    });
    let threw = false;
    let correctType = false;
    try {
      await deadGateway.checkVetting(FLAGGED_HASH);
    } catch (err) {
      threw = true;
      correctType = err instanceof RibUnavailableError;
    }
    check('unreachable RIB throws (no fabricated verdict)', threw);
    check('the fault is a RibUnavailableError', correctType);
  }

  await Promise.all([
    serviceBus.disconnect(),
    ribBus.disconnect(),
    auditBus.disconnect(),
    producerBus.disconnect(),
  ]);

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('CRIMINAL-CLEARANCE VETTING PROVEN OVER LIVE RIB + KAFKA ✓');
  else console.error(`${failures} ASSERTION(S) FAILED ✗`);
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err: unknown) => {
    console.error('\nSELF-CHECK CRASHED:', err);
    process.exit(1);
  });
