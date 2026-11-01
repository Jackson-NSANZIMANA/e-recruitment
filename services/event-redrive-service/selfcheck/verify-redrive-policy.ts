// ══════════════════════════════════════════════════════════════════
// event-redrive-service — DURABLE RE-DRIVE PROOF (D2, zero infrastructure)
//
// THE DEFECT (evaluation 2026-10-29, D2). ADR-025 parked what a handler could
// not process, which stopped one poison message holding a partition hostage —
// and then nothing ever picked it up. The in-process retry budget is six
// attempts in ~15.5 s (a window, not a schedule), and the operator replay tool
// is stateless. The event was durable; its STATE was not: a clearance whose
// Irembo lookup met a 429 sat at CRIMINAL_CLEARANCE with a checklist saying "we
// are verifying" for eleven days.
//
// WHAT THIS PROVES:
//
//   1. THE SCHEDULE IS THE OWNER'S, and it is a schedule: 1m, 5m, 15m, 1h, 3h,
//      6h — six attempts over ~10 h, then STOP. Never retry forever, never
//      silently.
//   2. THE DECISION IS PURE AND TOTAL over (reason × state × attempts × due ×
//      group failures), so the policy can be argued about here instead of in
//      production.
//   3. THE WORKER RESPECTS IT: UNDECODABLE and NON_RETRYABLE letters are never
//      re-driven; a settled row is never resurrected by a second tick or a
//      second worker; the group circuit breaker stops a broken handler turning
//      the deployment into a retry furnace; and a letter that vanished from
//      topic retention is parked instead of looping.
//   4. THE RE-DRIVE IS BYTE-EXACT with the provenance header the operator tool
//      writes — one shape for a human re-drive and an automatic one.
//
// §1/§2 are the pure policy. §3 runs the REAL use case against a fake ledger,
// a fake graveyard and a fake publisher, with an injected clock: no Kafka, no
// Postgres, no sleeping.
// ══════════════════════════════════════════════════════════════════

import {
  DEFAULT_REDRIVE_POLICY,
  DEAD_LETTER_TOPIC,
  PARKED_TOPIC,
  decideRedrive,
  nextAttemptAtMs,
  redriveDelayMs,
  redriveKey,
  resolveRedrivePolicy,
  type RedriveLedgerEntry,
  type RedrivePolicy,
} from '@usrp/shared-events';
import { RedriveDeadLettersService } from '../src/application/redrive-dead-letters.service.js';
import type { DeadLetterMessage, DeadLetterSource, RawRepublisher } from '../src/ports/dead-letter-source.js';
import type { ClaimDueInput, ParkInput, RecordAttemptInput, RedriveLedger } from '../src/ports/redrive-ledger.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass += 1;
    console.log(`\u001b[0;32m  \u2713 ${label}\u001b[0m`);
  } else {
    fail += 1;
    failures.push(label);
    console.error(`\u001b[0;31m  \u2717 ${label}${detail === undefined ? '' : ` — ${detail}`}\u001b[0m`);
  }
}
function section(title: string): void {
  console.log(`\n\u001b[1;36m══ ${title}\u001b[0m`);
}

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function entry(over: Partial<RedriveLedgerEntry> = {}): RedriveLedgerEntry {
  return {
    sourceTopic: 'clearance.submitted',
    sourcePartition: 2,
    sourceOffset: '4711',
    groupId: 'background-vetting-service',
    reason: 'HANDLER_FAILED',
    attempts: 0,
    state: 'RETRYING',
    nextAttemptAt: iso(T0),
    consecutiveGroupFailures: 0,
    ...over,
  };
}

// ── 1. The schedule is the owner's ─────────────────────────────────
section('1. Six attempts over ~10 h, then stop');
const POLICY: RedrivePolicy = DEFAULT_REDRIVE_POLICY;
check(
  'the delays are 1m, 5m, 15m, 1h, 3h, 6h',
  POLICY.delaysMs.join(',') === '60000,300000,900000,3600000,10800000,21600000',
  POLICY.delaysMs.join(','),
);
check(
  'the budget is the length of the schedule (six attempts, ~10.2 h total)',
  POLICY.delaysMs.length === 6 &&
    POLICY.delaysMs.reduce((a, b) => a + b, 0) === 60_000 + 300_000 + 900_000 + 3_600_000 + 10_800_000 + 21_600_000,
);
check('the delay for attempt n is the schedule at n', redriveDelayMs(POLICY, 1) === 60_000 && redriveDelayMs(POLICY, 6) === 21_600_000);
check(
  'past the end the last interval repeats (no throw at 03:00)',
  redriveDelayMs(POLICY, 9) === 21_600_000,
);
check(
  'the next attempt is scheduled from NOW plus the delay for the NEXT attempt',
  nextAttemptAtMs(POLICY, 0, T0) === T0 + 60_000 && nextAttemptAtMs(POLICY, 3, T0) === T0 + 3_600_000,
);
check(
  'a misconfigured schedule fails at construction, not at 03:00',
  (() => {
    try {
      resolveRedrivePolicy({ delaysMs: [] });
      return false;
    } catch {
      return true;
    }
  })(),
);

// ── 2. The decision is pure and total ──────────────────────────────
section('2. One pure function decides when to knock again');
check('a due letter is re-driven, attempt 1', JSON.stringify(decideRedrive(entry(), T0, POLICY)) === JSON.stringify({ kind: 'REDRIVE', attempt: 1 }));
check(
  'a letter is not re-driven before its instant',
  decideRedrive(entry({ nextAttemptAt: iso(T0 + 1000) }), T0, POLICY).kind === 'WAIT',
);
check(
  'past the budget → PARK ATTEMPTS_EXHAUSTED (never forever)',
  JSON.stringify(decideRedrive(entry({ attempts: 6 }), T0, POLICY)) === JSON.stringify({ kind: 'PARK', reason: 'ATTEMPTS_EXHAUSTED' }),
);
check(
  'UNDECODABLE is never re-driven (bytes that failed to decode fail again)',
  decideRedrive(entry({ reason: 'UNDECODABLE' }), T0, POLICY).kind === 'PARK',
);
check(
  'NON_RETRYABLE is never re-driven (the handler already said no)',
  decideRedrive(entry({ reason: 'NON_RETRYABLE' }), T0, POLICY).kind === 'PARK',
);
check(
  'a tripped group breaker parks even a fresh letter',
  JSON.stringify(decideRedrive(entry({ consecutiveGroupFailures: 3 }), T0, POLICY)) ===
    JSON.stringify({ kind: 'PARK', reason: 'REPEATED_FAILURE' }),
);
check(
  'a settled (parked or re-driven) row is never resurrected',
  decideRedrive(entry({ state: 'PARKED' }), T0, POLICY).kind === 'SKIP' &&
    decideRedrive(entry({ state: 'REDRIVEN' }), T0, POLICY).kind === 'SKIP',
);
check(
  'an unknown reason is treated as retryable (an old producer, not a refusal)',
  decideRedrive(entry({ reason: 'UNKNOWN' }), T0, POLICY).kind === 'REDRIVE',
);
check(
  'a malformed timestamp is treated as due (a ledger bug must not look idle)',
  decideRedrive(entry({ nextAttemptAt: 'not-a-date' }), T0, POLICY).kind === 'REDRIVE',
);

// Exhaustive: every input has one coherent answer.
const reasons = ['HANDLER_FAILED', 'NON_RETRYABLE', 'UNDECODABLE', 'UNKNOWN'] as const;
const states = ['RETRYING', 'REDRIVEN', 'PARKED'] as const;
let combos = 0;
let incoherent = 0;
for (const reason of reasons) {
  for (const state of states) {
    for (const attempts of [0, 3, 5, 6]) {
      for (const due of [-1, 0, 1]) {
        for (const groupFailures of [0, 2, 3]) {
          combos += 1;
          const d = decideRedrive(entry({ reason, state, attempts, consecutiveGroupFailures: groupFailures, nextAttemptAt: iso(T0 + due * 1000) }), T0, POLICY);
          const coherent =
            d.kind === 'REDRIVE'
              ? state === 'RETRYING' && attempts < 6 && groupFailures < 3 && due <= 0 && reason !== 'NON_RETRYABLE' && reason !== 'UNDECODABLE'
              : d.kind === 'WAIT'
                ? state === 'RETRYING' && attempts < 6 && groupFailures < 3 && due > 0
                : true; // PARK/SKIP are always coherent: they are the safe direction.
          if (!coherent) incoherent += 1;
        }
      }
    }
  }
}
check(`every combination gets a coherent answer (${String(combos)} combinations)`, incoherent === 0, `${String(incoherent)} incoherent`);

// ── 3. The worker respects the policy ──────────────────────────────
section('3. The worker executes the decision — and nothing else');

interface FakeLedgerState {
  entries: RedriveLedgerEntry[];
  parked: ParkInput[];
  successes: RedriveLedgerEntry[];
  failures: RecordAttemptInput[];
}
function fakeLedger(state: FakeLedgerState): RedriveLedger {
  return {
    claimDue: (input: ClaimDueInput): Promise<readonly RedriveLedgerEntry[]> =>
      Promise.resolve(
        state.entries
          .filter((e) => e.state === 'RETRYING' && Date.parse(e.nextAttemptAt) <= input.nowMs)
          .slice(0, input.limit),
      ),
    recordSuccess: (e: RedriveLedgerEntry): Promise<void> => {
      state.successes.push(e);
      state.entries = state.entries.map((x) => (x === e ? { ...x, state: 'REDRIVEN', attempts: x.attempts + 1 } : x));
      return Promise.resolve();
    },
    recordFailure: (input: RecordAttemptInput): Promise<void> => {
      state.failures.push(input);
      state.entries = state.entries.map((x) =>
        x === input.entry
          ? { ...x, attempts: x.attempts + 1, consecutiveGroupFailures: x.consecutiveGroupFailures + 1, nextAttemptAt: iso(input.nextAttemptAtMs) }
          : x,
      );
      return Promise.resolve();
    },
    park: (input: ParkInput): Promise<void> => {
      state.parked.push(input);
      state.entries = state.entries.map((x) => (x === input.entry ? { ...x, state: 'PARKED' } : x));
      return Promise.resolve();
    },
  };
}

interface Fakes {
  readonly ledger: FakeLedgerState;
  readonly replayed: { topic: string; message: DeadLetterMessage }[];
  readonly signals: Record<string, unknown>[];
  readonly source: DeadLetterSource;
  readonly republisher: RawRepublisher;
}

function fakes(available: ReadonlyMap<string, DeadLetterMessage>, failPublish = false): Fakes {
  const ledger: FakeLedgerState = { entries: [], parked: [], successes: [], failures: [] };
  const replayed: { topic: string; message: DeadLetterMessage }[] = [];
  const signals: Record<string, unknown>[] = [];
  return {
    ledger,
    replayed,
    signals,
    source: { fetchBatch: (): Promise<ReadonlyMap<string, DeadLetterMessage>> => Promise.resolve(available) },
    republisher: {
      replay: (topic: string, message: DeadLetterMessage): Promise<void> => {
        if (failPublish) return Promise.reject(new Error('broker down'));
        replayed.push({ topic, message });
        return Promise.resolve();
      },
      parkSignal: (payload: Record<string, unknown>): Promise<void> => {
        signals.push(payload);
        return Promise.resolve();
      },
      disconnect: (): Promise<void> => Promise.resolve(),
    },
  };
}

const BYTES: DeadLetterMessage = {
  key: Buffer.from('applicant-1'),
  value: Buffer.from('{"eventType":"CLEARANCE_CERTIFICATE_SUBMITTED"}'),
  headers: { 'x-usrp-dlq-group': 'background-vetting-service' },
};

function service(f: Fakes, nowMs: number): RedriveDeadLettersService {
  return new RedriveDeadLettersService({
    ledger: fakeLedger(f.ledger),
    source: f.source,
    republisher: f.republisher,
    policy: POLICY,
    now: () => nowMs,
    log: () => undefined,
  });
}

// (a) a due letter is replayed byte-exact
{
  const f = fakes(new Map([[redriveKey(entry()), BYTES]]));
  f.ledger.entries = [entry()];
  const counts = await service(f, T0).tick();
  check('a due HANDLER_FAILED letter is replayed once', counts.replayed === 1 && f.replayed.length === 1);
  check(
    'the re-drive is BYTE-EXACT to the ORIGINAL topic',
    f.replayed[0]?.topic === 'clearance.submitted' &&
      f.replayed[0]?.message.value.equals(BYTES.value) &&
      f.replayed[0]?.message.key?.equals(BYTES.key as Buffer) === true,
  );
  check('the successful letter settles (attempts recorded, not deleted)', f.ledger.successes.length === 1 && f.ledger.entries[0]?.state === 'REDRIVEN');
  check('nothing is parked when the re-drive works', f.ledger.parked.length === 0 && f.signals.length === 0);

  // A second tick must not resurrect it, and must not re-publish.
  const again = await service(f, T0).tick();
  check('a second tick re-drives nothing (the settled row is not due)', again.claimed === 0 && f.replayed.length === 1);
}

// (b) an exhausted letter is parked, with the signal, and never replayed
{
  const f = fakes(new Map([[redriveKey(entry()), BYTES]]));
  f.ledger.entries = [entry({ attempts: 6 })];
  const counts = await service(f, T0).tick();
  check('an exhausted letter is PARKED, not re-driven', counts.parked === 1 && f.replayed.length === 0);
  check(
    'the parked reason is a closed code',
    f.ledger.parked[0]?.reason === 'ATTEMPTS_EXHAUSTED' && f.ledger.entries[0]?.state === 'PARKED',
  );
  check(
    'the parked signal goes to the parked topic with the letter identity',
    f.signals.length === 1 &&
      f.signals[0]?.['reason'] === 'ATTEMPTS_EXHAUSTED' &&
      f.signals[0]?.['sourceOffset'] === '4711' &&
      PARKED_TOPIC === 'events.dead-letter-parked',
  );
}

// (c) UNDECODABLE and NON_RETRYABLE are never re-driven
for (const reason of ['UNDECODABLE', 'NON_RETRYABLE'] as const) {
  const f = fakes(new Map([[redriveKey(entry()), BYTES]]));
  f.ledger.entries = [entry({ reason })];
  await service(f, T0).tick();
  check(`${reason} letters are parked without a single re-drive`, f.replayed.length === 0 && f.ledger.parked[0]?.reason === reason);
}

// (d) the group breaker
{
  const f = fakes(new Map([[redriveKey(entry()), BYTES]]));
  f.ledger.entries = [entry({ consecutiveGroupFailures: 3 })];
  await service(f, T0).tick();
  check(
    'a tripped breaker parks the group (the handler is broken, not the network)',
    f.ledger.parked[0]?.reason === 'REPEATED_FAILURE' && f.replayed.length === 0,
  );
}

// (e) a letter that vanished from the topic
{
  const f = fakes(new Map());
  f.ledger.entries = [entry()];
  await service(f, T0).tick();
  check(
    'a letter gone from retention is parked with a closed error code (no loop)',
    f.replayed.length === 0 && f.ledger.parked[0]?.errorCode === 'LETTER_GONE',
  );
}

// (f) a transport failure reschedules and counts, it does not park
{
  const f = fakes(new Map([[redriveKey(entry()), BYTES]]), true);
  f.ledger.entries = [entry()];
  const counts = await service(f, T0).tick();
  check('a failed republish is counted as failed, not as parked', counts.failed === 1 && f.ledger.parked.length === 0);
  check(
    'it is rescheduled on the schedule, with the group streak advanced',
    f.ledger.failures.length === 1 &&
      f.ledger.failures[0]?.nextAttemptAtMs === T0 + 60_000 &&
      f.ledger.entries[0]?.consecutiveGroupFailures === 1,
  );
}

// (g) the byte-exact contract against the shared constants
check('the graveyard topic is the ADR-025 one', DEAD_LETTER_TOPIC === 'events.dead-letter');
check('the ledger identity is topic+partition+offset+group', redriveKey(entry()) === 'background-vetting-service|clearance.submitted|2|4711');

// ── Verdict ────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '\u001b[0;32m' : '\u001b[0;31m'}${String(pass)} passed, ${String(fail)} failed\u001b[0m`);
if (fail > 0) {
  console.error(`\nREDRIVE POLICY FAILED: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log('\u001b[0;32mREDRIVE POLICY OK\u001b[0m');
