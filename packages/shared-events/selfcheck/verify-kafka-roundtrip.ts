// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Live KafkaEventBus round-trip self-check (ADR-001)
//
// Proves the production event backbone for real: publish a
// NIDA_VERIFICATION_COMPLETED event through KafkaEventBus to a LIVE Kafka
// broker, consume it back through a real consumer group on the routed
// topic, and assert the event survives the wire byte-for-byte with its
// envelope (correlation/causation) intact and lands on the correct topic
// and partition key. This is the difference between "we have a Kafka
// adapter" and "Kafka works end-to-end".
//
//   Run (repo root), with tier2 Kafka up (host listener on :29092):
//   KAFKA_BROKERS=localhost:29092 \
//   pnpm --filter @usrp/shared-events selfcheck:kafka
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import type { NIDAVerificationCompletedEvent } from '@usrp/shared-types';
import {
  KafkaEventBus,
  newCorrelationContext,
  newEnvelope,
  topicForEvent,
  partitionKeyForEvent,
  type EventMeta,
} from '../src/index.js';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(',');
const GROUP_ID = `selfcheck-roundtrip-${randomUUID()}`; // fresh group each run

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function buildEvent(): NIDAVerificationCompletedEvent {
  const ctx = newCorrelationContext();
  return {
    ...newEnvelope(ctx),
    eventType: 'NIDA_VERIFICATION_COMPLETED',
    applicantId: randomUUID(),
    nidaRequestId: randomUUID(),
    verified: true,
    matchConfidence: null,
    homeDistrict: 'GASABO',
    homeProvince: 'KIGALI_CITY',
  };
}

async function main(): Promise<void> {
  console.log(`\nKafka round-trip — brokers=${BROKERS.join(',')} group=${GROUP_ID}`);

  const producerBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-producer' });
  const consumerBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-consumer' });

  const sent = buildEvent();
  const expectedTopic = topicForEvent(sent);
  const expectedKey = partitionKeyForEvent(sent);
  check('routes to vetting.nida', expectedTopic === 'vetting.nida', expectedTopic);

  // A promise that resolves when our specific event is consumed back.
  let resolveReceived: (v: { event: NIDAVerificationCompletedEvent; meta: EventMeta }) => void;
  const received = new Promise<{ event: NIDAVerificationCompletedEvent; meta: EventMeta }>((resolve) => {
    resolveReceived = resolve;
  });

  await consumerBus.subscribe([expectedTopic], GROUP_ID, (event, meta) => {
    if (event.eventType === 'NIDA_VERIFICATION_COMPLETED' && event.eventId === sent.eventId) {
      resolveReceived({ event, meta });
    }
  });
  // New consumer group joins at the log end (fromBeginning:false). Give the
  // group time to be assigned partitions before publishing, so we don't miss it.
  await new Promise((r) => setTimeout(r, 4000));

  await producerBus.publish(sent);
  console.log(`  → published eventId=${sent.eventId} to ${expectedTopic}`);

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timed out after 20s waiting to consume the event')), 20_000),
  );
  const { event: got, meta } = await Promise.race([received, timeout]);

  console.log('\n── Assertions on the consumed event ─────────────────────────');
  check('same eventId round-tripped', got.eventId === sent.eventId);
  check('correlationId preserved on the wire', got.correlationId === sent.correlationId, got.correlationId);
  check('causationId preserved on the wire', got.causationId === sent.causationId);
  check('applicantId preserved', got.applicantId === sent.applicantId);
  check('verified flag preserved', got.verified === true);
  check('homeDistrict preserved', got.homeDistrict === 'GASABO');
  check('eventVersion preserved', got.eventVersion === '1.0');
  check('delivered on topic vetting.nida', meta.topic === 'vetting.nida', meta.topic);
  check('partition key = applicantId', meta.key === expectedKey, `${meta.key} vs ${expectedKey}`);

  await Promise.all([producerBus.disconnect(), consumerBus.disconnect()]);

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('KAFKA ROUND-TRIP PROVEN — event backbone works ✓');
  else console.error(`${failures} ASSERTION(S) FAILED ✗`);
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err: unknown) => {
    console.error('\nSELF-CHECK CRASHED:', err);
    process.exit(1);
  });
