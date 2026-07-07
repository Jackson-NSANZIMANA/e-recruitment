// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — Public types (ADR-005)
//
// The contract a service adapter programs against. Handlers receive a
// RequestContext and return an HttpResult (or throw an HttpError); the
// server owns everything else — parsing, headers, logging, lifecycle.
// ══════════════════════════════════════════════════════════════════

import type { IncomingHttpHeaders } from 'node:http';

/** What a route handler returns; the body is JSON-serialized by the server. */
export interface HttpResult {
  readonly status: number;
  /** Serialized as JSON. Omit for an empty body (e.g. 204). */
  readonly body?: unknown;
  /** Extra response headers, merged over the server defaults. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Per-request handle passed to handlers. Body parsing is lazy and bounded. */
export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  /**
   * Correlation id for the whole causal chain — taken from the inbound
   * `x-correlation-id` header, or a fresh id when absent. Seed it into the
   * event context so an HTTP request and the events it causes share a trace.
   */
  readonly correlationId: string;
  /** Unique id for THIS request (always fresh); echoed as `x-request-id`. */
  readonly requestId: string;
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
  /** Max request body size in bytes (default 64 KiB). */
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
