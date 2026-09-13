// ══════════════════════════════════════════════════════════════════
// edge-gateway — Fixed-window rate limiter
//
// On the OTP and identity operations this is a CORRECTNESS requirement, not
// hardening. `POST otp/request` answers 202 for every outcome precisely so it
// cannot be used to ask "does this National ID exist" — but an endpoint that
// reveals nothing per request still reveals plenty at ten thousand requests per
// minute, by timing and by which requests eventually produce an SMS. Without a
// limiter the uniform 202 is an oracle with extra steps.
//
// TWO DIMENSIONS, because either alone is trivially bypassed:
//   client   one address may not sweep many National IDs.
//   subject  many addresses may not converge on one National ID.
//
// THE SUBJECT KEY IS A KEYED HASH OF THE NATIONAL ID, never the ID itself: the
// limiter's own state would otherwise be a list of every National ID submitted
// to the portal, sitting in memory in the most exposed process in the platform.
//
// HONEST LIMITATION: the window is per PROCESS. With N replicas the effective
// budget is N× the configured one. It is a real bound (the numbers are chosen
// so N× is still far below an enumeration rate) and it is not the same thing as
// a shared limiter — a Postgres- or gateway-level counter is the follow-on, and
// Kong in front of the edge can enforce a global ceiling today.
// ══════════════════════════════════════════════════════════════════

import type { IncomingHttpHeaders } from 'node:http';
import { hmacSha256Hex } from '@usrp/shared-security';

export interface RateLimiterOptions {
  readonly perClient: number;
  readonly perSubject: number;
  readonly windowSeconds: number;
  /** Keys the subject hash. Reuses the edge session HMAC key. SECRET. */
  readonly subjectHmacKey: string;
  readonly clientIpHeader: string;
  /** Injectable clock for proofs. */
  readonly now?: () => number;
}

interface Window {
  count: number;
  resetAtMs: number;
}

export class RateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #options: RateLimiterOptions;
  readonly #now: () => number;

  constructor(options: RateLimiterOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Count one attempt. Returns false when the caller is over budget on either
   * dimension. BOTH dimensions are counted even when the first one trips, so a
   * client cannot avoid its subject budget by first exhausting its own.
   */
  allow(operation: string, headers: IncomingHttpHeaders, subject: string | null): boolean {
    const clientOk = this.#count(
      `c:${operation}:${this.#clientKey(headers)}`,
      this.#options.perClient,
    );
    const subjectOk =
      subject === null
        ? true
        : this.#count(`s:${operation}:${this.#subjectKey(subject)}`, this.#options.perSubject);
    return clientOk && subjectOk;
  }

  /** Drop expired windows. Called on a timer by the composition root. */
  sweep(): void {
    const now = this.#now();
    for (const [key, window] of this.#windows) {
      if (window.resetAtMs <= now) this.#windows.delete(key);
    }
  }

  #count(key: string, limit: number): boolean {
    const now = this.#now();
    const existing = this.#windows.get(key);
    if (existing === undefined || existing.resetAtMs <= now) {
      this.#windows.set(key, { count: 1, resetAtMs: now + this.#options.windowSeconds * 1000 });
      return true;
    }
    existing.count += 1;
    return existing.count <= limit;
  }

  /**
   * The client address as the TRUSTED PROXY saw it.
   *
   * The RIGHTMOST entry is used. A proxy APPENDS the peer address it observed,
   * so the last element is the only one a client cannot forge by sending its own
   * `x-forwarded-for` header. Taking the leftmost — the usual reflex, because it
   * is "the real client" in a chain of trusted proxies — hands the attacker a
   * free reset of every bucket.
   *
   * With no header at all every caller shares one bucket. That is deliberate:
   * the limit still binds (conservatively), where a per-request random key would
   * silently disable limiting the moment the proxy stopped setting the header.
   */
  #clientKey(headers: IncomingHttpHeaders): string {
    const raw = headers[this.#options.clientIpHeader];
    const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (typeof value !== 'string' || value.length === 0) return 'unattributed';
    const hops = value.split(',');
    const last = hops[hops.length - 1]?.trim();
    return last !== undefined && last.length > 0 ? last : 'unattributed';
  }

  #subjectKey(subject: string): string {
    return hmacSha256Hex(this.#options.subjectHmacKey, subject);
  }
}
