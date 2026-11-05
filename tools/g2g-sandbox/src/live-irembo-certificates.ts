// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — the opt-in LIVE IremboGov certificate passthrough
//
// SANDBOX_IREMBO_LIVE=1 (set locally, never committed): a well-formed
// certificate application number that the SYNTHETIC population does not hold is
// asked of the real public IremboGov endpoint instead of answered "not found":
//
//   GET https://irembo.gov.rw/irembo/rest/public/request/verify-certificate-by-application-number
//   applicationnumber: <letter, 12 digits, 4 letters>
//   x-current-user-role: ROLE_CITIZEN
//
// Same fences as the live-NESA passthrough (ADR-047 §3.6):
//   • sandbox profile only (never development, so never CI);
//   • it lives in the SIMULATOR, so no USRP service ever holds a real registry
//     URL; background-vetting-service still talks to the simulator only;
//   • rate-limited: at most one upstream request per MIN_INTERVAL_MS, and a
//     number answered in the last REPLAY_MS is replayed, not re-asked;
//   • a found answer is re-validated against the captured contract; a drift is
//     502 and a log line naming paths only;
//   • a status:false answer is passed through VERBATIM, so the gateway's own
//     mapping decides (3105 → not found; anything else → retryable fault). Its
//     responseCode — a closed code, never a value — is logged so the owner can
//     capture the real "not found" code, which is still a sandbox assumption.
// No body value (name, date of birth, number) is ever logged.
// ══════════════════════════════════════════════════════════════════

import { validateContract } from './contracts.js';
import type { SandboxLog } from './log.js';

export const LIVE_IREMBO_DEFAULT_BASE_URL = 'https://irembo.gov.rw';
export const LIVE_IREMBO_PATH = '/irembo/rest/public/request/verify-certificate-by-application-number';
const MIN_INTERVAL_MS = 2_000;
const REPLAY_MS = 60_000;

export type LiveCertificateAnswer =
  | { readonly kind: 'OK'; readonly body: unknown }
  | { readonly kind: 'THROTTLED'; readonly retryAfterSeconds: number }
  | { readonly kind: 'DRIFT'; readonly paths: readonly string[] }
  | { readonly kind: 'UNAVAILABLE' };

export interface LiveIremboCertificates {
  fetch(applicationNumber: string): Promise<LiveCertificateAnswer>;
}

export interface LiveIremboCertificatesOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  readonly log: SandboxLog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createLiveIremboCertificates(options: LiveIremboCertificatesOptions): LiveIremboCertificates {
  const baseUrl = (options.baseUrl ?? LIVE_IREMBO_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? Date.now;
  let lastCallAt = Number.NEGATIVE_INFINITY;
  const replay = new Map<string, { readonly at: number; readonly body: unknown }>();

  return {
    async fetch(applicationNumber): Promise<LiveCertificateAnswer> {
      const now = clock();
      const cached = replay.get(applicationNumber);
      if (cached !== undefined && now - cached.at < REPLAY_MS) return { kind: 'OK', body: cached.body };
      if (now - lastCallAt < MIN_INTERVAL_MS) {
        return { kind: 'THROTTLED', retryAfterSeconds: Math.max(1, Math.ceil((MIN_INTERVAL_MS - (now - lastCallAt)) / 1000)) };
      }
      lastCallAt = now;
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, options.timeoutMs ?? 10_000);
      try {
        const response = await fetchImpl(`${baseUrl}${LIVE_IREMBO_PATH}`, {
          method: 'GET',
          headers: { accept: 'application/json, text/plain, */*', applicationnumber: applicationNumber, 'x-current-user-role': 'ROLE_CITIZEN' },
          signal: controller.signal,
        });
        if (!response.ok) {
          options.log.warn('live_irembo_unavailable', { status: response.status });
          return { kind: 'UNAVAILABLE' };
        }
        const body: unknown = await response.json();
        if (!isRecord(body) || typeof body['status'] !== 'boolean') {
          options.log.warn('live_irembo_schema_drift', { reason: 'envelope is not {status:boolean,...}' });
          return { kind: 'DRIFT', paths: ['/status'] };
        }
        if (body['status']) {
          const paths = validateContract('irembo-certificate-verification', body);
          if (paths.length > 0) {
            options.log.warn('live_irembo_schema_drift', { reason: `${String(paths.length)} path(s) differ from the captured shape` });
            return { kind: 'DRIFT', paths };
          }
        }
        const responseCode = typeof body['responseCode'] === 'string' && /^[0-9]{1,6}$/.test(body['responseCode']) ? body['responseCode'] : 'unreadable';
        // The redacting logger keeps only allowlisted keys: the code travels as `reason`.
        options.log.info('live_irembo_answered', { live: true, reason: `status ${String(body['status'])}, responseCode ${responseCode}` });
        if (replay.size >= 256) replay.clear();
        replay.set(applicationNumber, { at: now, body });
        return { kind: 'OK', body };
      } catch {
        options.log.warn('live_irembo_unavailable', { reason: 'network' });
        return { kind: 'UNAVAILABLE' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
