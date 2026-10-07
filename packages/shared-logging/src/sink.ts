// ══════════════════════════════════════════════════════════════════
// @usrp/shared-logging — the redacting structured sink
//
// The ONE way a service or shared package emits an operational line. Every
// call produces exactly the line the old raw `console.log(JSON.stringify({
// msg, ...fields }))` produced — same `msg`, same field names, same order
// (msg first) — with one difference: the fields pass through redact() first.
// Callers were not careless; the point is that the guarantee no longer
// depends on each call site being careful forever.
//
// WHY process.stdout.write AND NOT console.log
// --------------------------------------------
// Two reasons, and the second is the important one.
//
//   1. It is what a log sink is. console.* is a developer-convenience wrapper
//      (format specifiers, inspect(), per-instance state) over these exact
//      streams. A sink that has already serialised its line to a string wants
//      the fd, not the formatter.
//   2. It keeps the `no-console` rule TRUE EVERYWHERE instead of carving out
//      an exemption for this file. The alternatives were to add this path to
//      the eslint config's allow-list or to sprinkle an eslint-disable here —
//      both of which weaken the rule to accommodate the implementation. This
//      sink is the one place that may write to the process streams, and it
//      does so without asking the linter for permission. The rule stays at
//      full strength and this file passes it honestly.
//
// Behaviourally identical to console.log for a string argument: both write
// the string plus a trailing newline to the same stream, with the same
// sync/async characteristics per fd type.
//
// STDOUT vs STDERR follows the existing convention: info -> stdout, warn and
// error -> stderr, so operators keep the stream split they already alert on.
// ══════════════════════════════════════════════════════════════════

import { redact } from './redact.js';

/** The structured fields of one log line. `msg` is supplied separately. */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Build the exact line that gets written. Exported so proofs can assert on
 * the string without capturing a stream.
 *
 * `msg` leads the object, as every existing line in this codebase does, so
 * `grep '"msg":"outbox_relayed"'` keeps working unchanged.
 */
export function structuredLine(msg: string, fields: LogFields = {}): string {
  const redacted = redact(fields) as Record<string, unknown>;
  return JSON.stringify({ msg, ...redacted });
}

/** Operational line, stdout. The replacement for `console.log(JSON.stringify(...))`. */
export function logInfo(msg: string, fields: LogFields = {}): void {
  process.stdout.write(`${structuredLine(msg, fields)}\n`);
}

/** Degraded-but-serving line, stderr. */
export function logWarn(msg: string, fields: LogFields = {}): void {
  process.stderr.write(`${structuredLine(msg, fields)}\n`);
}

/** Fault line, stderr. */
export function logError(msg: string, fields: LogFields = {}): void {
  process.stderr.write(`${structuredLine(msg, fields)}\n`);
}
