// ══════════════════════════════════════════════════════════════════
// @usrp/shared-security — G2G request signing (NIDA / NESA / HEC / RIB)
//
// Outbound government-to-government calls are HMAC-signed over a canonical
// request string and carry a timestamp for replay protection — matching
// the x-hmac-signature / x-request-id / x-timestamp header scheme the G2G
// mocks (and real endpoints) expect.
// ══════════════════════════════════════════════════════════════════

import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from './hashing.js';

export interface G2GRequestParams {
  readonly method: string;
  readonly path: string;
  /** ISO-8601 UTC timestamp. */
  readonly timestamp: string;
  readonly requestId: string;
  /** Raw request body as it will be sent on the wire ('' when none). */
  readonly body: string;
}

export interface G2GSignedHeaders {
  readonly 'x-hmac-signature': string;
  readonly 'x-request-id': string;
  readonly 'x-timestamp': string;
}

/** Default replay window: reject requests whose timestamp skews > 5 min. */
export const DEFAULT_G2G_MAX_SKEW_MS = 300_000;

function canonicalRequestString(p: G2GRequestParams): string {
  return [p.method.toUpperCase(), p.path, p.timestamp, p.requestId, sha256Hex(p.body)].join('\n');
}

/** Produce the signed headers for an outbound G2G request. */
export function signG2GRequest(hmacSecret: string, params: G2GRequestParams): G2GSignedHeaders {
  return {
    'x-hmac-signature': hmacSha256Hex(hmacSecret, canonicalRequestString(params)),
    'x-request-id': params.requestId,
    'x-timestamp': params.timestamp,
  };
}

export interface G2GVerifyOptions {
  readonly maxSkewMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: number;
}

/**
 * Verify a G2G request signature AND its timestamp freshness. Returns
 * false (never throws) on signature mismatch, malformed timestamp, or
 * replay outside the skew window.
 */
export function verifyG2GRequest(
  hmacSecret: string,
  params: G2GRequestParams,
  providedSignature: string,
  options: G2GVerifyOptions = {},
): boolean {
  const expected = hmacSha256Hex(hmacSecret, canonicalRequestString(params));
  if (!timingSafeEqualHex(expected, providedSignature)) return false;

  const requestTime = Date.parse(params.timestamp);
  if (Number.isNaN(requestTime)) return false;

  const maxSkew = options.maxSkewMs ?? DEFAULT_G2G_MAX_SKEW_MS;
  const now = options.now ?? Date.now();
  return Math.abs(now - requestTime) <= maxSkew;
}
