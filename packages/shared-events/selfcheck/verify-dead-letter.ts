// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Live dead-letter + bounded-retry self-check (ADR-025)
//
// Proves, over a LIVE broker, the property that matters: a poison message no
// longer freezes its partition. Five messages are produced IN ORDER onto ONE
// partition (same key):
//
//   1. raw garbage bytes          → UNDECODABLE, dead-lettered, never handled
//   2. valid event V1             → handled
//   3. event the handler always   → retried exactly maxHandlerAttempts times,
//      throws on (transient-looking)  then HANDLER_FAILED, dead-lettered
//   4. event the handler rejects  → NonRetryableEventError: ONE attempt,
//      as permanently unprocessable   NON_RETRYABLE, dead-lettered
//   5. valid event V2             → handled — the head-of-line proof
//
// Before ADR-025, message 1 alone would have blocked 2..5 forever.
//
// Uses vetting.nida (no service consumes it) and fresh consumer groups, so the
// garbage it writes can reach no other proof or service.
//
//   KAFKA_BROKERS=localhost:29092 npx tsx packages/shared-events/selfcheck/verify-dead-letter.ts
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { Kafka, logLevel, type IHeaders } from 'kafkajs';
import type { NIDAVerificationCompletedEvent } from '@usrp/shared-types';
import {
  DEAD_LETTER_TOPIC,
  DLQ_HEADERS,
  KafkaEventBus,
  NonRetryableEventError,
  newCorrelationContext,
  newEnvelope,
} from '../src/index.js';

const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:29092').split(',');
const TOPIC = 'vetting.nida';
const GROUP_ID = `selfcheck-dlq-${randomUUID()}`;
const SHARED_KEY = randomUUID(); // one applicantId ⇒ one partition ⇒ strict order
const MAX_ATTEMPTS = 3;
const GARBAGE = Buffer.from('{"this is": not a usrp event', 'utf8');

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function buildEvent(): NIDAVerificationCompletedEvent {
  return {
    ...newEnvelope(newCorrelationContext()),
    eventType: 'NIDA_VERIFICATION_COMPLETED',
    applicantId: SHARED_KEY,
    nidaRequestId: randomUUID(),
    verified: true,
    matchConfidence: null,
    homeDistrict: 'GASABO',
    homeProvince: 'KIGALI_CITY',
  };
}

function header(headers: IHeaders | undefined, name: string): string | undefined {
  const raw = headers?.[name];
  if (raw === undefined) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first === undefined ? undefined : first.toString();
}

interface Parked {
  readonly key: string | undefined;
  readonly value: Buffer | null;
  readonly headers: IHeaders | undefined;
}

async function waitFor(predicate: () => boolean, desc: string, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`  ⏱ timed out waiting for: ${desc}`);
  return false;
}

async function main(): Promise<void> {
  console.log(`\nDead-letter proof — brokers=${BROKERS.join(',')} group=${GROUP_ID}`);

  const bus = new KafkaEventBus({
    brokers: BROKERS,
    clientId: 'selfcheck-dlq-consumer',
    // Small backoff so the proof is fast; the attempt COUNT is what is asserted.
    deadLetter: { maxHandlerAttempts: MAX_ATTEMPTS, baseBackoffMs: 50, maxBackoffMs: 200 },
  });
  const producerBus = new KafkaEventBus({ brokers: BROKERS, clientId: 'selfcheck-dlq-producer' });
  const kafka = new Kafka({ clientId: 'selfcheck-dlq-raw', brokers: BROKERS, logLevel: logLevel.ERROR });
  const rawProducer = kafka.producer({ allowAutoTopicCreation: false });
  const watcher = kafka.consumer({ groupId: `selfcheck-dlq-watch-${randomUUID()}` });

  const v1 = buildEvent();
  const poison = buildEvent();
  const fatal = buildEvent();
  const v2 = buildEvent();

  const attempts = new Map<string, number>();
  const handled: string[] = [];
  await bus.subscribe([TOPIC], GROUP_ID, (event) => {
    if (event.eventType !== 'NIDA_VERIFICATION_COMPLETED' || event.applicantId !== SHARED_KEY) return;
    attempts.set(event.eventId, (attempts.get(event.eventId) ?? 0) + 1);
    if (event.eventId === poison.eventId) throw new Error('simulated persistent handler fault');
    if (event.eventId === fatal.eventId) throw new NonRetryableEventError('simulated unprocessable event');
    handled.push(event.eventId);
  });

  const parked: Parked[] = [];
  await rawProducer.connect();
  await watcher.connect();
  await watcher.subscribe({ topics: [DEAD_LETTER_TOPIC], fromBeginning: false });
  await watcher.run({
    eachMessage: async ({ message }): Promise<void> => {
      if (header(message.headers, DLQ_HEADERS.GROUP) !== GROUP_ID) return;
      parked.push({ key: message.key?.toString(), value: message.value, headers: message.headers });
    },
  });

  // Fresh groups join at the log end; let partition assignment settle first.
  await new Promise((r) => setTimeout(r, 5000));

  // Produce strictly in order onto one partition.
  await rawProducer.send({ topic: TOPIC, messages: [{ key: SHARED_KEY, value: GARBAGE }] });
  await producerBus.publish(v1);
  await producerBus.publish(poison);
  await producerBus.publish(fatal);
  await producerBus.publish(v2);
  console.log('  → produced garbage, V1, poison, fatal, V2 on one partition');

  await waitFor(() => handled.includes(v2.eventId), 'V2 handled (behind garbage + poison)');
  await waitFor(() => parked.length >= 3, 'three dead letters for this group');

  console.log('\n── 1. No head-of-line blocking ──────────────────────────────');
  check('V1 handled despite garbage ahead of it', handled.includes(v1.eventId));
  check('V2 handled despite poison + fatal ahead of it', handled.includes(v2.eventId));
  check('per-partition order preserved (V1 before V2)', handled.indexOf(v1.eventId) < handled.indexOf(v2.eventId));
  check('valid events handled exactly once', attempts.get(v1.eventId) === 1 && attempts.get(v2.eventId) === 1);

  console.log('\n── 2. Retry budget is bounded and honoured ───────────────────');
  check(`poison retried exactly ${MAX_ATTEMPTS} times`, attempts.get(poison.eventId) === MAX_ATTEMPTS, String(attempts.get(poison.eventId)));
  check('NonRetryableEventError skips the retry budget (1 attempt)', attempts.get(fatal.eventId) === 1, String(attempts.get(fatal.eventId)));

  console.log('\n── 3. Dead letters are complete and replayable ───────────────');
  const byReason = (r: string): Parked | undefined => parked.find((p) => header(p.headers, DLQ_HEADERS.REASON) === r);
  const undecodable = byReason('UNDECODABLE');
  const failed = byReason('HANDLER_FAILED');
  const nonRetryable = byReason('NON_RETRYABLE');
  check('exactly three dead letters for this group', parked.length === 3, String(parked.length));
  check('garbage parked as UNDECODABLE', undecodable !== undefined);
  check('UNDECODABLE keeps the original bytes (byte-exact replay)', undecodable?.value?.equals(GARBAGE) === true);
  check('UNDECODABLE keeps the original key (same partition on replay)', undecodable?.key === SHARED_KEY);
  check('UNDECODABLE records zero handler attempts', header(undecodable?.headers, DLQ_HEADERS.ATTEMPTS) === '0');
  check('poison parked as HANDLER_FAILED', failed !== undefined);
  check('HANDLER_FAILED names the event', header(failed?.headers, DLQ_HEADERS.EVENT_ID) === poison.eventId);
  check(`HANDLER_FAILED records ${MAX_ATTEMPTS} attempts`, header(failed?.headers, DLQ_HEADERS.ATTEMPTS) === String(MAX_ATTEMPTS));
  check('HANDLER_FAILED records source topic', header(failed?.headers, DLQ_HEADERS.SOURCE_TOPIC) === TOPIC);
  check('HANDLER_FAILED records source offset', /^\d+$/.test(header(failed?.headers, DLQ_HEADERS.SOURCE_OFFSET) ?? ''));
  check('error header is bounded (<= 512 chars)', (header(failed?.headers, DLQ_HEADERS.ERROR) ?? '').length <= 512);
  check('fatal parked as NON_RETRYABLE', header(nonRetryable?.headers, DLQ_HEADERS.EVENT_ID) === fatal.eventId);

  await Promise.all([bus.disconnect(), producerBus.disconnect(), rawProducer.disconnect(), watcher.disconnect()]);

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('POISON MESSAGES CONTAINED — RETRY BOUNDED, DEAD-LETTERED, PARTITION FLOWS ✓');
  else console.error(`${failures} ASSERTION(S) FAILED ✗`);
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err: unknown) => {
    console.error('\nSELF-CHECK CRASHED:', err);
    process.exit(1);
  });
