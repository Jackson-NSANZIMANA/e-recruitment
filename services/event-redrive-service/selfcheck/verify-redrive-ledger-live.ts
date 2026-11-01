// ══════════════════════════════════════════════════════════════════
// verify-redrive-ledger-live — the Postgres half of D2 (needs DATABASE_URL)
//
// verify-redrive-policy proves the schedule with fakes. This proves the SQL the
// fakes stand in for: intake is idempotent, a RETURNING event inherits what it
// already spent (so the cap terminates), the schedule is honoured, letters that
// can never be retried are due now, and the cursor only moves forward.
// Rows are never deleted by design, so each run uses its own random topic.
// ══════════════════════════════════════════════════════════════════
import { randomUUID } from 'node:crypto';
import { sql } from '@usrp/shared-database';
import { DEFAULT_REDRIVE_DELAYS_MS, type DeadLetterHeader } from '@usrp/shared-events';
import { PgRedriveLedger } from '../src/adapters/redrive-ledger.pg.js';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.error(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); }
}

const ledger = new PgRedriveLedger();
const topic = `selfcheck.${randomUUID().slice(0, 8)}`;
const group = 'selfcheck-group';
const base = Math.floor(Date.now() / 1000); // unique, monotonic dead-letter offsets
const letter = (offset: number, over: Partial<DeadLetterHeader> = {}): DeadLetterHeader => ({
  groupId: group, sourceTopic: topic, partition: 0, offset: String(base + offset),
  reason: 'HANDLER_FAILED', eventId: 'evt-live-1', ...over,
});
const mine = async (nowMs: number) =>
  (await ledger.claimDue({ nowMs, limit: 500 })).filter((e) => e.sourceTopic === topic);
const T = Date.now();
const D = [...DEFAULT_REDRIVE_DELAYS_MS];

try {
  const first = await ledger.intake({ letters: [letter(0)], next: new Map([[0, String(base + 1)]]), nowMs: T, delaysMs: D });
  check('intake registers a new letter', first.registered === 1, first);
  const again = await ledger.intake({ letters: [letter(0)], next: new Map([[0, String(base + 1)]]), nowMs: T, delaysMs: D });
  check('intake is idempotent on the letter identity', again.registered === 0, again);
  check('nothing is due before the first delay', (await mine(T + D[0]! - 1000)).length === 0);
  const due = await mine(T + D[0]! + 1000);
  check('it is due after the first delay', due.length === 1 && due[0]?.attempts === 0, due);

  await ledger.recordSuccess(due[0]!, T + D[0]!);
  const back = await ledger.intake({ letters: [letter(1)], next: new Map([[0, String(base + 2)]]), nowMs: T + D[0]!, delaysMs: D });
  check('a RETURNING event is a new row', back.registered === 1, back);
  check('…not due yet: scheduled by its SECOND delay', (await mine(T + D[0]! + D[1]! - 1000)).length === 0);
  const second = await mine(T + D[0]! + D[1]! + 1000);
  check('…and it INHERITED the attempt already spent (the cap can terminate)', second.length === 1 && second[0]?.attempts === 1, second);

  const dead = await ledger.intake({ letters: [letter(2, { eventId: 'evt-live-2', reason: 'NON_RETRYABLE' })], next: new Map([[0, String(base + 3)]]), nowMs: T, delaysMs: D });
  check('a never-retryable letter is registered', dead.registered === 1, dead);
  check('…and is due NOW so it parks immediately', (await mine(T + 1)).some((e) => e.reason === 'NON_RETRYABLE'));

  const cursor = await ledger.readCursor('events.dead-letter');
  check('the cursor advanced to at least the last offset + 1', BigInt(cursor.get(0) ?? '0') >= BigInt(base + 3), [...cursor]);
  await ledger.intake({ letters: [], next: new Map([[0, '1']]), nowMs: T, delaysMs: D });
  check('the cursor never moves backwards', BigInt((await ledger.readCursor('events.dead-letter')).get(0) ?? '0') >= BigInt(base + 3));
} finally {
  await sql.end({ timeout: 2 }).catch(() => undefined);
}
console.log(`\n${String(pass)} passed, ${String(fail)} failed`);
if (fail > 0) process.exit(1);
console.log('REDRIVE LEDGER LIVE OK');
