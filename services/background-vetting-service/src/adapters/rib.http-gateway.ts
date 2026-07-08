// ══════════════════════════════════════════════════════════════════
// background-vetting-service — RIB gateway adapter (HTTP over the G2G tunnel)
//
// Talks to the RIB criminal-records registry (mocked in dev by usrp-rib-mock).
// Signs every request with the RIB-shared HMAC secret and a fresh requestId +
// timestamp for replay protection — the exact x-hmac-signature / x-request-id
// / x-timestamp scheme NIDA/NESA/HEC use, so the adapter is forward-compatible
// with a real, signature-enforcing RIB even though the dev mock does not
// currently verify the signature.
//
// The request body carries only { nationalIdHash, requestId } — no raw NID,
// no name, no PII. RIB answers with a single status flag and nothing else.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { signG2GRequest, type G2GSignedHeaders } from '@usrp/shared-security';
import { type RIBRecordStatus } from '@usrp/shared-types';
import type { RibGateway } from '../ports/rib.gateway.js';
import { RibUnavailableError, type RibCheckResult } from '../domain/rib.types.js';

const CHECK_PATH = '/v1/vetting/check';
const VALID_STATUSES: ReadonlySet<string> = new Set<RIBRecordStatus>([
  'CLEAR',
  'HAS_RECORDS',
  'UNDER_INVESTIGATION',
]);

export interface RibHttpGatewayOptions {
  readonly baseUrl: string;
  /** RIB-shared HMAC secret — signs G2G requests. */
  readonly hmacSecret: string;
  readonly timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Minimal shape we read from a vetting-check response. */
interface RibCheckWire {
  readonly status?: unknown;
}

export class RibHttpGateway implements RibGateway {
  private readonly baseUrl: string;
  private readonly hmacSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RibHttpGatewayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.hmacSecret = options.hmacSecret;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async checkVetting(nationalIdHash: string): Promise<RibCheckResult> {
    const requestId = randomUUID();
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ nationalIdHash, requestId });

    const signed = signG2GRequest(this.hmacSecret, {
      method: 'POST',
      path: CHECK_PATH,
      timestamp,
      requestId,
      body,
    });

    const response = await this.post(body, signed, requestId);
    return this.mapResponse(response, requestId);
  }

  private async post(
    body: string,
    signed: G2GSignedHeaders,
    requestId: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${CHECK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signed },
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      // Network error or timeout abort — an infrastructure fault.
      const reason = cause instanceof Error ? cause.name : 'unknown';
      throw new RibUnavailableError(`RIB request failed (${reason})`, requestId);
    } finally {
      clearTimeout(timer);
    }
  }

  private async mapResponse(response: Response, requestId: string): Promise<RibCheckResult> {
    if (!response.ok) {
      throw new RibUnavailableError(`RIB returned HTTP ${response.status}`, requestId);
    }

    let wire: RibCheckWire;
    try {
      wire = (await response.json()) as RibCheckWire;
    } catch {
      throw new RibUnavailableError('RIB returned a non-JSON body', requestId);
    }

    if (typeof wire.status !== 'string' || !VALID_STATUSES.has(wire.status)) {
      throw new RibUnavailableError(
        `RIB returned unexpected status "${String(wire.status)}"`,
        requestId,
      );
    }

    return { status: wire.status as RIBRecordStatus, ribRequestId: requestId };
  }
}
