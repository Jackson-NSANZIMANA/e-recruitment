// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — the opt-in LIVE IremboGov certificate passthrough
//
// SANDBOX_IREMBO_LIVE=1 plus SANDBOX_IREMBO_LIVE_NUMBERS (set locally, never
// committed): ONLY the certificate application numbers listed there — one per
// consented private subject (ADR-047 §3.5), like the single owner index of the
// live-NESA passthrough (§3.6) — are asked of the real public IremboGov endpoint.
// Every other number is answered by the simulator, so a sandbox reachable on a
// network can never be used to query Irembo about anyone else:
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
//     mapping decides (3103 → not found, as captured; anything else → retryable
//     fault). Its responseCode — a closed code, never a value — is logged, so a
//     new upstream code shows up in the log instead of silently retrying.
// No body value (name, date of birth, number) is ever logged.
// ══════════════════════════════════════════════════════════════════

import { validateContract } from './contracts.js';
import type { SandboxLog } from './log.js';

export const LIVE_IREMBO_DEFAULT_BASE_URL = 'https://irembo.gov.rw';
export const LIVE_IREMBO_PATH = '/irembo/rest/public/request/verify-certificate-by-application-number';
const MIN_INTERVAL_MS = 2_000;
const REPLAY_MS = 60_000;
/**
 * Below background-vetting-service's own IREMBO_CERTIFICATES_TIMEOUT_MS default (5 s), so a slow
 * upstream answers as a 503 the service retries, instead of an answer nobody is waiting for.
 */
const UPSTREAM_TIMEOUT_MS = 4_000;

export type LiveCertificateAnswer =
  | { readonly kind: 'OK'; readonly body: unknown }
  | { readonly kind: 'THROTTLED'; readonly retryAfterSeconds: number }
  | { readonly kind: 'DRIFT'; readonly paths: readonly string[] }
  | { readonly kind: 'UNAVAILABLE' };

export interface LiveIremboCertificates {
  /** True only for a number on the owner's allowlist. */
  appliesTo(applicationNumber: string): boolean;
  fetch(applicationNumber: string): Promise<LiveCertificateAnswer>;
}

export interface LiveIremboCertificatesOptions {
  /** The allowlisted certificate application numbers (SANDBOX_IREMBO_LIVE_NUMBERS). */
  readonly numbers: ReadonlySet<string>;
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
    appliesTo: (applicationNumber) => options.numbers.has(applicationNumber),
    async fetch(applicationNumber): Promise<LiveCertificateAnswer> {
      // Belt and braces: the module asks appliesTo first, but this never calls out for an unlisted number.
      if (!options.numbers.has(applicationNumber)) return { kind: 'UNAVAILABLE' };
      const now = clock();
      const cached = replay.get(applicationNumber);
      if (cached !== undefined && now - cached.at < REPLAY_MS) return { kind: 'OK', body: cached.body };
      if (now - lastCallAt < MIN_INTERVAL_MS) {
        return { kind: 'THROTTLED', retryAfterSeconds: Math.max(1, Math.ceil((MIN_INTERVAL_MS - (now - lastCallAt)) / 1000)) };
      }
      lastCallAt = now;
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, options.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
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
