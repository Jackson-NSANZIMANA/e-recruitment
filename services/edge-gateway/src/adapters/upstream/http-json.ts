// ══════════════════════════════════════════════════════════════════
// edge-gateway — The one place the edge speaks HTTP to an upstream
//
// Every upstream call goes through here, which is what makes four rules
// enforceable instead of aspirational:
//
//  1. RETRY IS A PROPERTY OF THE OPERATION, NOT THE CALL SITE. `retryOnG2G`
//     arrives from the operation registry. It is FALSE for every write that
//     changes application state — a retried transition is a double write on a
//     citizen's legal record. A call site cannot opt a write into retrying
//     because there is no argument here that would let it.
//
//  2. THE CORRELATION ID IS FORWARDED, NEVER INVENTED. The browser mints one
//     per user action; a click stitches to the backend events and the Kafka
//     trace it causes only if every hop passes the same value along.
//
//  3. A G2G FAULT KEEPS ITS NAME. `NIDA_UNAVAILABLE` reaches the browser as
//     itself: "the national ID service is unavailable, try shortly" is
//     actionable, "something went wrong" is not. Anything else 503-shaped
//     collapses to UPSTREAM_UNAVAILABLE.
//
//  4. THE CREDENTIAL IS NEVER LOGGED. Upstream faults are reported by STATUS
//     and operation, never by echoing the request that caused them.
// ══════════════════════════════════════════════════════════════════

import { UpstreamError } from '../../domain/errors.js';
import type { UpstreamContext } from '../../ports/upstream.js';

/** The G2G authority codes the frontend is allowed to distinguish. */
const NAMED_G2G_AUTHORITIES: ReadonlySet<string> = new Set([
  'NIDA_UNAVAILABLE',
  'NESA_UNAVAILABLE',
  'RIB_UNAVAILABLE',
  'HEC_UNAVAILABLE',
  'SCANNER_UNAVAILABLE',
  'ELIGIBILITY_STORE_UNAVAILABLE',
  'UPSTREAM_UNAVAILABLE',
]);

const RETRY_DELAY_MS = 250;

export interface UpstreamRequest {
  readonly method: 'GET' | 'POST';
  /** Absolute URL. Built from a PATH CONSTANT exported by the upstream service. */
  readonly url: string;
  /** The upstream credential. Passed as a Bearer; never logged. */
  readonly bearer?: string;
  readonly body?: unknown;
  /** From the operation registry. See rule 1 above. */
  readonly retryOnG2G: boolean;
  readonly ctx: UpstreamContext;
}

export interface UpstreamResponse {
  readonly status: number;
  /** Parsed JSON, or undefined for an empty body. Never trusted — projected. */
  readonly body: unknown;
}

export interface UpstreamClientOptions {
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export class UpstreamClient {
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: UpstreamClientOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async send(request: UpstreamRequest): Promise<UpstreamResponse> {
    const first = await this.#attempt(request);
    if (first.status !== 503 || !request.retryOnG2G) return first;
    // One retry, and only for an operation whose registry entry permits it.
    await delay(RETRY_DELAY_MS);
    return this.#attempt(request);
  }

  /**
   * Send, or throw an UpstreamError naming the authority. A 503/502 body is
   * read for its code because that code is the whole diagnostic value.
   */
  async sendOrThrow(request: UpstreamRequest): Promise<UpstreamResponse> {
    const response = await this.send(request);
    if (response.status === 503 || response.status === 502) {
      throw new UpstreamError(authorityOf(response.body), 'Upstream dependency unavailable');
    }
    return response;
  }

  async #attempt(request: UpstreamRequest): Promise<UpstreamResponse> {
    const headers: Record<string, string> = { 'x-correlation-id': request.ctx.correlationId };
    if (request.bearer !== undefined) headers['authorization'] = `Bearer ${request.bearer}`;
    if (request.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.#fetch(request.url, {
        method: request.method,
        headers,
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      // Unreachable / timed out. Never include the request — it may carry a
      // National ID, a password or a bearer token.
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'Upstream service unreachable', { cause });
    }

    if (response.status === 204) return { status: 204, body: undefined };
    const text = await response.text().catch(() => '');
    if (text.length === 0) return { status: response.status, body: undefined };
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      // A non-JSON body from a JSON API is an upstream fault, not a client one.
      throw new UpstreamError(
        'UPSTREAM_UNAVAILABLE',
        `Upstream returned a non-JSON body with status ${response.status}`,
      );
    }
  }
}

/** Read the named authority from an upstream error body, or fall back. */
export function authorityOf(body: unknown): string {
  const code = readString(body, 'error');
  return code !== null && NAMED_G2G_AUTHORITIES.has(code) ? code : 'UPSTREAM_UNAVAILABLE';
}

// ── Narrowing helpers ──────────────────────────────────────────────────
// Upstream bodies are `unknown` and stay that way until something has
// CHECKED them. These are how an allowlist projection is written without a
// schema library (shared packages carry no runtime dependencies).

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function readString(value: unknown, key: string): string | null {
  const record = asRecord(value);
  if (record === null) return null;
  const field = record[key];
  return typeof field === 'string' ? field : null;
}

export function readNumber(value: unknown, key: string): number | null {
  const record = asRecord(value);
  if (record === null) return null;
  const field = record[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

export function readArray(value: unknown, key: string): readonly unknown[] {
  const record = asRecord(value);
  if (record === null) return [];
  const field = record[key];
  return Array.isArray(field) ? (field as readonly unknown[]) : [];
}

export function readUnknown(value: unknown, key: string): unknown {
  const record = asRecord(value);
  return record === null ? undefined : record[key];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
