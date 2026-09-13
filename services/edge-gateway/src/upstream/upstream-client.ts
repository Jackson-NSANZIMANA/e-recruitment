// ══════════════════════════════════════════════════════════════════
// edge-gateway — The upstream transport
//
// FOUR HARD RULES, each the answer to a specific way this tier could go wrong:
//
//   1. IT RETRIES NOTHING. Not writes, not reads, not timeouts. Retry is the
//      browser's decision, taken from `retryOnG2G` in the operation registry,
//      and a retry hidden inside the proxy is one the registry cannot forbid.
//      A retried transition is a double write on a citizen's legal record; a
//      retried score sync is a duplicated exam result.
//   2. IT NEVER FORWARDS AN INBOUND HEADER. The request sent upstream is built
//      from scratch. A browser cannot smuggle an Authorization header, an
//      agency hint, or an x-forwarded-* claim through this tier, because
//      nothing the browser sent is copied — there is no allowlist to get wrong.
//   3. IT BOUNDS TIME AND BYTES. One deadline per call, one byte ceiling per
//      response. An upstream that hangs must not hold a browser socket, and an
//      upstream that streams must not exhaust the edge's heap.
//   4. IT MAPS FAULTS TO NAMED CODES. "NIDA is unavailable, try shortly" is
//      actionable; "something went wrong" is not. Only the G2G codes the
//      contract enumerates are passed through; anything else collapses to
//      UPSTREAM_UNAVAILABLE so an upstream message cannot become a leak.
// ══════════════════════════════════════════════════════════════════

import { HttpError } from '@usrp/shared-http';
import type { EdgeUpstreamConfig } from '../config.js';
import type { UpstreamOperation, UpstreamService } from '../registry/upstream-operations.js';

/** The only 503 codes the contract permits the browser to see. */
export const G2G_ERROR_CODES: ReadonlySet<string> = new Set([
  'NIDA_UNAVAILABLE',
  'NESA_UNAVAILABLE',
  'RIB_UNAVAILABLE',
  'HEC_UNAVAILABLE',
  'SCANNER_UNAVAILABLE',
  'ELIGIBILITY_STORE_UNAVAILABLE',
  'UPSTREAM_UNAVAILABLE',
]);

export interface UpstreamResult {
  readonly status: number;
  /** Parsed JSON, or null for an empty body. Never a raw stream. */
  readonly body: unknown;
}

export interface UpstreamCallInput {
  readonly operation: UpstreamOperation;
  readonly correlationId: string;
  /** Query parameters. Built by the edge from validated input, never forwarded. */
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /**
   * The credential to present. The edge asserts it matches what the operation
   * declares it needs, so a refactor cannot quietly send an applicant token to
   * an officer route.
   */
  readonly credential?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a bounded body. Refuses rather than truncates — a truncated JSON
 *  document that happens to parse is worse than a clean failure. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new HttpError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', undefined, { expose: false });
    }
  }
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', undefined, { expose: false });
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

export class UpstreamClient {
  readonly #config: EdgeUpstreamConfig;

  constructor(config: EdgeUpstreamConfig) {
    this.#config = config;
  }

  #baseUrl(service: UpstreamService): string {
    switch (service) {
      case 'iam':
        return this.#config.iamBaseUrl;
      case 'identity':
        return this.#config.identityBaseUrl;
      case 'application':
        return this.#config.applicationBaseUrl;
      case 'field-sync':
        return this.#config.fieldSyncBaseUrl;
      default: {
        const exhaustive: never = service;
        throw new Error(`Unknown upstream service: ${String(exhaustive)}`);
      }
    }
  }

  async call(input: UpstreamCallInput): Promise<UpstreamResult> {
    const { operation } = input;

    if (operation.credential === 'none' && input.credential !== undefined) {
      throw new Error(`Upstream ${operation.id} takes no credential; one was supplied.`);
    }
    if (operation.credential !== 'none' && (input.credential === undefined || input.credential === '')) {
      throw new Error(`Upstream ${operation.id} requires a ${operation.credential} credential.`);
    }

    const url = new URL(operation.path, this.#baseUrl(operation.service));
    if (input.query !== undefined) {
      for (const [key, value] of Object.entries(input.query)) {
        url.searchParams.set(key, value);
      }
    }

    // Built from scratch. Nothing from the browser's header set appears here.
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-correlation-id': input.correlationId,
    };
    if (input.credential !== undefined && input.credential !== '') {
      headers.authorization = `Bearer ${input.credential}`;
    }
    if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    // An explicit controller rather than AbortSignal.timeout: one deadline, one
    // call, no ambient state, and cleared in `finally` so a fast response does
    // not leave a timer holding the event loop.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.#config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: operation.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: controller.signal,
        // No redirect following: an upstream 3xx is a misconfiguration, and
        // following one could send the credential to an unintended origin.
        redirect: 'manual',
      });
    } catch (err) {
      // Timeout, DNS failure, connection refused — indistinguishable to the
      // browser and all meaning the same thing: this dependency is not there.
      throw new UpstreamUnavailableError('UPSTREAM_UNAVAILABLE', operation.id, err);
    } finally {
      clearTimeout(deadline);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new UpstreamUnavailableError('UPSTREAM_UNAVAILABLE', operation.id);
    }

    const raw = await readBounded(response, this.#config.maxResponseBytes);
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new UpstreamUnavailableError('UPSTREAM_UNAVAILABLE', operation.id);
      }
    }

    // 502/503/504 from an upstream is a dependency fault, not a client answer.
    // A named G2G authority survives; anything else is generalized.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      const named = isRecord(body) && typeof body.error === 'string' ? body.error : undefined;
      const code = named !== undefined && G2G_ERROR_CODES.has(named) ? named : 'UPSTREAM_UNAVAILABLE';
      throw new UpstreamUnavailableError(code, operation.id);
    }

    return { status: response.status, body };
  }
}

/** A named dependency is down. Rendered as the contract's 503 G2GError. */
export class UpstreamUnavailableError extends Error {
  readonly code: string;
  readonly upstreamOperationId: string;

  constructor(code: string, upstreamOperationId: string, cause?: unknown) {
    super(`Upstream ${upstreamOperationId} unavailable (${code})`, { cause });
    this.name = 'UpstreamUnavailableError';
    this.code = code;
    this.upstreamOperationId = upstreamOperationId;
  }
}
