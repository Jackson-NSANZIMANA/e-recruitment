// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — Public types (ADR-005)
//
// The contract a service adapter programs against. Handlers receive a
// RequestContext and return an HttpResult (or throw an HttpError); the
// server owns everything else — parsing, headers, cookies, CORS, logging,
// lifecycle.
// ══════════════════════════════════════════════════════════════════

import type { IncomingHttpHeaders } from 'node:http';
import type { SetCookie } from './cookies.js';

/** What a route handler returns; the body is JSON-serialized by the server. */
export interface HttpResult {
  readonly status: number;
  /** Serialized as JSON. Omit for an empty body (e.g. 204). */
  readonly body?: unknown;
  /** Extra response headers, merged over the server defaults. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Cookies to emit, one `Set-Cookie` each.
   *
   * A FIRST-CLASS FIELD, not a header: `headers` is Record<string, string> and
   * can therefore express exactly ONE Set-Cookie. The edge tier needs two per
   * login (the httpOnly session handle plus the readable CSRF echo), so the
   * header map cannot represent a correct response at all.
   */
  readonly cookies?: readonly SetCookie[];
}

/** Per-request handle passed to handlers. Body parsing is lazy and bounded. */
export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  /** Lower-cased `content-type` (empty string when absent). */
  readonly contentType: string;
  /**
   * Inbound cookies. Parsed lazily, first-occurrence-wins (a duplicate name
   * is the cookie-shadowing trick; a deterministic jar is what makes the CSRF
   * double-submit comparison meaningful).
   */
  readonly cookies: ReadonlyMap<string, string>;
  /**
   * Correlation id for the whole causal chain — taken from the inbound
   * `x-correlation-id` header, or a fresh id when absent. Seed it into the
   * event context so an HTTP request and the events it causes share a trace.
   */
  readonly correlationId: string;
  /** Unique id for THIS request (always fresh); echoed as `x-request-id`. */
  readonly requestId: string;
  /**
   * The raw request body, bounded by the route's byte cap (cached across
   * calls). The PRIMITIVE — `json()` is layered on top and shares the same
   * buffer, so a body can never be consumed twice. Reach for this only when
   * the bytes are not JSON (multipart document upload); throws HttpError 413
   * over the cap.
   */
  rawBody(): Promise<Buffer>;
  /**
   * Parse the JSON request body (cached across calls). Throws HttpError:
   * 415 on a non-JSON content-type, 413 over the size cap, 400 on empty or
   * malformed JSON.
   */
  json<T = unknown>(): Promise<T>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<HttpResult> | HttpResult;

/** An exact-match route. Path matching is exact (no params in this substrate). */
export interface Route {
  readonly method: string;
  readonly path: string;
  readonly handler: RouteHandler;
  /**
   * Per-route body cap in bytes, overriding the server default.
   *
   * OPT-IN ON PURPOSE. Only a route that genuinely ingests files (document
   * upload) may raise it. Lifting the server-wide default to suit one upload
   * route would hand every other route the same large-payload DoS budget.
   * Resolved BEFORE the request context is built, so the cap is bound to the
   * matched route rather than negotiated by the caller.
   */
  readonly maxBodyBytes?: number;
}

/**
 * Cross-origin policy. Supply it only on browser-facing processes (the edge
 * tier); internal microservices leave it unset and emit no CORS headers.
 */
export interface CorsPolicy {
  /** Exact-match allow-list. Never a pattern — see cors.ts. */
  readonly origins: readonly string[];
  /** Send `Allow-Credentials: true`. Required for cookie-based sessions. */
  readonly credentials?: boolean;
  readonly allowedMethods?: readonly string[];
  readonly allowedHeaders?: readonly string[];
  readonly exposedHeaders?: readonly string[];
  readonly preflightMaxAgeSeconds?: number;
}

/** Readiness probe backing `GET /ready`; return false to report not-ready. */
export type ReadinessProbe = () => Promise<boolean> | boolean;

/** One structured access-log record per request. Never carries body or PII. */
export interface AccessLogRecord {
  readonly service: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
  readonly requestId: string;
  readonly correlationId: string;
}

export type AccessLogger = (record: AccessLogRecord) => void;

export interface HttpServerOptions {
  readonly serviceName: string;
  readonly port: number;
  readonly routes: readonly Route[];
  /** Bind address. Defaults to 0.0.0.0. Use 127.0.0.1 to bind loopback only. */
  readonly host?: string;
  /** Default max request body size in bytes (default 64 KiB). */
  readonly maxBodyBytes?: number;
  /** Grace period before in-flight connections are force-closed (default 10s). */
  readonly shutdownTimeoutMs?: number;
  /** Backs `GET /ready`; when omitted, readiness is always true. */
  readonly readiness?: ReadinessProbe;
  /** Access logger; defaults to structured JSON on stdout/stderr. */
  readonly logger?: AccessLogger;
  /** Run during graceful shutdown, after the socket drains (e.g. close bus/db). */
  readonly onShutdown?: () => Promise<void> | void;
  /** Install SIGTERM/SIGINT → graceful shutdown handlers (default true). */
  readonly handleSignals?: boolean;
  /**
   * Cross-origin policy. Omit on internal services — a microservice that is
   * never called by a browser should emit no CORS headers at all.
   */
  readonly cors?: CorsPolicy;
}

/** A running server handle. */
export interface HttpServer {
  /** A reachable base URL (loopback host substituted for 0.0.0.0). */
  readonly url: string;
  /** The bound port (resolved — meaningful when listening on port 0). */
  readonly port: number;
  /** Stop accepting, drain in-flight, run onShutdown. Idempotent. */
  stop(): Promise<void>;
}
