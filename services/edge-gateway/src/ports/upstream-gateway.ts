// ══════════════════════════════════════════════════════════════════
// edge-gateway — Upstream gateway port
//
// The abstract interface for calling upstream microservices (iam-service,
// identity-service, application-service, field-sync-service). The application
// layer orchestrates upstream calls through this port without knowing whether
// they are HTTP, gRPC, or a test stub.
//
// Implementations: adapters/upstream.http-gateway.ts (production)
// ══════════════════════════════════════════════════════════════════

import type { UpstreamOperation } from '../domain/upstream-operations.js';

/**
 * Input for calling an upstream operation. The edge builds this from validated
 * browser input and the resolved session.
 */
export interface UpstreamCallInput {
  /** The upstream operation to invoke (from the registry). */
  readonly operation: UpstreamOperation;
  /** Correlation id for distributed tracing. */
  readonly correlationId: string;
  /** Query parameters (built by the edge, never forwarded from the browser). */
  readonly query?: Readonly<Record<string, string>>;
  /** Request body (JSON-serializable). */
  readonly body?: unknown;
  /**
   * The credential to present upstream (officer JWT or applicant session
   * handle). The edge asserts this matches what the operation declares it
   * needs, so a refactor cannot quietly send an applicant token to an officer
   * route.
   */
  readonly credential?: string;
}

/**
 * Result from an upstream call. The body is parsed JSON (or null for empty
 * responses); it is never a raw stream.
 */
export interface UpstreamResult {
  readonly status: number;
  /** Parsed JSON body, or null for empty responses. */
  readonly body: unknown;
}

/**
 * Upstream gateway port. The application layer uses this to call backend
 * microservices without coupling to HTTP, fetch(), or any transport.
 *
 * The gateway enforces the four hard rules:
 *   1. NO RETRIES (retry is the browser's decision)
 *   2. NO HEADER FORWARDING (requests built from scratch)
 *   3. BOUNDED TIME AND BYTES (deadline and byte cap)
 *   4. NAMED FAULT CODES (only contract-approved G2G codes pass through)
 *
 * Throws UpstreamUnavailableError (from domain/edge.errors.ts) on 5xx or
 * timeout, which the HTTP adapter maps to 503 with the G2G error code.
 */
export interface UpstreamGateway {
  /**
   * Call an upstream operation. Throws UpstreamUnavailableError on 5xx,
   * timeout, or network failure; returns the result for all other statuses
   * (2xx, 4xx) so the caller can decide how to map them.
   *
   * @param input Upstream call parameters
   * @returns Upstream response (status + parsed body)
   * @throws UpstreamUnavailableError when the upstream is down/slow/broken
   */
  call(input: UpstreamCallInput): Promise<UpstreamResult>;
}
