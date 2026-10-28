// ══════════════════════════════════════════════════════════════════
// shared-sms — the Twilio channel's two cost guards
//
//   DailyCostCap     at most N accepted messages per Kigali calendar day.
//                    With a state file the count survives a restart and is
//                    shared by every process pointed at the same file (an
//                    append-only line per accepted message), so a crash loop
//                    or a second service cannot reset it.
//   PerNumberLimiter at most M messages to one number per window; keys are
//                    one-way digests, so no number is held or logged.
// ══════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The Kigali (UTC+2, no DST) calendar day of `now`, YYYY-MM-DD. */
export function kigaliDay(now: Date): string {
  return new Date(now.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

export class DailyCostCap {
  private day = '';
  private count = 0;

  constructor(
    readonly limit: number,
    private readonly stateFile: string | null = null,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('The daily SMS cap must be a positive integer.');
    if (stateFile !== null) mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  }

  /** Messages already accepted today. */
  used(): number {
    const today = kigaliDay(this.clock());
    if (this.stateFile === null) {
      if (this.day !== today) { this.day = today; this.count = 0; }
      return this.count;
    }
    if (!existsSync(this.stateFile)) return 0;
    const lines = readFileSync(this.stateFile, 'utf8').split('\n').filter((l) => l !== '');
    const todays = lines.filter((l) => l === today).length;
    // Drop yesterday's lines once a new day starts (best effort).
    if (todays === 0 && lines.length > 0) writeFileSync(this.stateFile, '', { mode: 0o600 });
    return todays;
  }

  allows(): boolean {
    return this.used() < this.limit;
  }

  record(): void {
    const today = kigaliDay(this.clock());
    if (this.stateFile === null) {
      if (this.day !== today) { this.day = today; this.count = 0; }
      this.count += 1;
      return;
    }
    appendFileSync(this.stateFile, `${today}\n`, { mode: 0o600 });
  }
}

export class PerNumberLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {
    if (!Number.isInteger(max) || max < 1 || windowMs < 1000) throw new Error('Invalid per-number SMS limit.');
  }

  private key(destination: string): string {
    return createHash('sha256').update(`sms-rate:${destination}`).digest('hex').slice(0, 24);
  }

  /** Take one slot for this destination; false when it is over its limit. */
  take(destination: string): boolean {
    const now = this.clock();
    const key = this.key(destination);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) {
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}
