// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — the opt-in LIVE-NESA passthrough (ADR-047 §3.6)
//
// SANDBOX_NESA_LIVE=1 plus exactly one SANDBOX_NESA_LIVE_INDEX (set locally,
// never committed): for that one index number the nesa-sdms simulator fetches
// the real public SDMS endpoint instead of answering itself.
//
//   • sandbox profile only (never development, so never CI);
//   • at most ONE upstream request per minute; within the minute the last
//     good answer is replayed, otherwise 429 + Retry-After;
//   • every live answer is re-validated against the captured schema; a drift
//     is 502 + a log line naming paths only;
//   • it lives in the SIMULATOR, so no USRP service ever holds a real
//     registry URL (deviation from the ADR text "the adapter calls"; the
//     service-side fence stays absolute).
// ══════════════════════════════════════════════════════════════════

import { validateContract } from './contracts.js';
import type { SandboxLog } from './log.js';

export const LIVE_NESA_DEFAULT_BASE_URL = 'https://rne.sdms.gov.rw';
const MIN_INTERVAL_MS = 60_000;

export type LiveAnswer =
  | { readonly kind: 'OK'; readonly record: unknown }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'THROTTLED'; readonly retryAfterSeconds: number }
  | { readonly kind: 'DRIFT'; readonly paths: readonly string[] }
  | { readonly kind: 'UNAVAILABLE' };

export interface LiveNesaPassthrough {
  appliesTo(indexNumber: string): boolean;
  fetch(indexNumber: string): Promise<LiveAnswer>;
}

export interface LiveNesaOptions {
  readonly index: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  readonly log: SandboxLog;
}

export function createLiveNesa(options: LiveNesaOptions): LiveNesaPassthrough {
  const baseUrl = (options.baseUrl ?? LIVE_NESA_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? Date.now;
  let lastCallAt = Number.NEGATIVE_INFINITY;
  let lastGood: unknown = null;
  return {
    appliesTo: (indexNumber) => indexNumber === options.index,
    async fetch(indexNumber): Promise<LiveAnswer> {
      if (indexNumber !== options.index) return { kind: 'UNAVAILABLE' };
      const now = clock();
      if (now - lastCallAt < MIN_INTERVAL_MS) {
        if (lastGood !== null) return { kind: 'OK', record: lastGood };
        return { kind: 'THROTTLED', retryAfterSeconds: Math.ceil((MIN_INTERVAL_MS - (now - lastCallAt)) / 1000) };
      }
      lastCallAt = now;
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, options.timeoutMs ?? 10_000);
      try {
        const response = await fetchImpl(`${baseUrl}/api/v1/public/results/by-index?indexNumber=${encodeURIComponent(indexNumber)}`, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (response.status === 404) return { kind: 'NOT_FOUND' };
        if (!response.ok) {
          options.log.warn('live_nesa_unavailable', { status: response.status });
          return { kind: 'UNAVAILABLE' };
        }
        const record: unknown = await response.json();
        const paths = validateContract('sdms-results-by-index', record);
        if (paths.length > 0) {
          options.log.warn('live_nesa_schema_drift', { reason: `${String(paths.length)} path(s) differ from the captured shape` });
          return { kind: 'DRIFT', paths };
        }
        lastGood = record;
        options.log.info('live_nesa_answered', { live: true });
        return { kind: 'OK', record };
      } catch {
        options.log.warn('live_nesa_unavailable', { reason: 'network' });
        return { kind: 'UNAVAILABLE' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
