// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — Minimal HTTP server over node:http (ADR-005)
//
// A deliberately small, zero-dependency ingress substrate shared by every
// USRP service. It gives a hexagonal adapter exactly what it needs —
// typed routing, bounded JSON parsing, a uniform error shape,
// health/readiness, correlation-id propagation, one structured access-log
// line per request, and graceful shutdown — and nothing more. Business
// logic lives in the service core; this only moves bytes at the edge.
// ══════════════════════════════════════════════════════════════════

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import type {
  AccessLogRecord,
  AccessLogger,
  HttpResult,
  HttpServer,
  HttpServerOptions,
  RequestContext,
  RouteHandler,
} from './types.js';

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function defaultAccessLogger(record: AccessLogRecord): void {
  const line = JSON.stringify({ msg: 'http_request', ...record });
  if (record.status >= 500) console.error(line);
  else console.log(line);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Map any thrown value to a client-safe result. 5xx details are withheld. */
function errorToResult(err: unknown): HttpResult {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: err.expose ? { error: err.code, detail: err.message } : { error: err.code },
    };
  }
  return { status: 500, body: { error: 'INTERNAL_ERROR' } };
}

/**
 * Start an HTTP server for a service. Resolves once the socket is listening.
 * Routes are matched exactly on method + path; `/health` and `/ready` are
 * reserved and served by the transport itself.
 */
export function startHttpServer(options: HttpServerOptions): Promise<HttpServer> {
  const {
    serviceName,
    port,
    routes,
    host = '0.0.0.0',
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    handleSignals = true,
  } = options;
  const readiness = options.readiness;
  const onShutdown = options.onShutdown;
  const log = options.logger ?? defaultAccessLogger;

  // path → (method → handler)
  const table = new Map<string, Map<string, RouteHandler>>();
  for (const route of routes) {
    const method = route.method.toUpperCase();
    const byMethod = table.get(route.path) ?? new Map<string, RouteHandler>();
    byMethod.set(method, route.handler);
    table.set(route.path, byMethod);
  }

  async function dispatch(ctx: RequestContext): Promise<HttpResult> {
    if (ctx.method === 'GET' && ctx.path === '/health') {
      return { status: 200, body: { status: 'ok', service: serviceName } };
    }
    if (ctx.method === 'GET' && ctx.path === '/ready') {
      const ready = readiness ? await readiness() : true;
      return {
        status: ready ? 200 : 503,
        body: { status: ready ? 'ready' : 'not_ready', service: serviceName },
      };
    }
    const byMethod = table.get(ctx.path);
    if (byMethod === undefined) {
      throw new HttpError(404, 'NOT_FOUND', `No route for ${ctx.method} ${ctx.path}.`);
    }
    const handler = byMethod.get(ctx.method);
    if (handler === undefined) {
      return {
        status: 405,
        headers: { allow: [...byMethod.keys()].sort().join(', ') },
        body: { error: 'METHOD_NOT_ALLOWED', detail: `${ctx.method} is not allowed for ${ctx.path}.` },
      };
    }
    return handler(ctx);
  }

  function buildContext(
    req: IncomingMessage,
    url: URL,
    method: string,
    requestId: string,
    correlationId: string,
  ): RequestContext {
    let cached: unknown;
    let parsed = false;
    async function json<T = unknown>(): Promise<T> {
      if (!parsed) {
        const contentType = (firstHeader(req.headers['content-type']) ?? '').toLowerCase();
        if (!contentType.includes('application/json')) {
          throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
        }
        const raw = await readBody(req, maxBodyBytes);
        if (raw.length === 0) {
          throw new HttpError(400, 'EMPTY_BODY', 'A JSON request body is required.');
        }
        try {
          cached = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, 'MALFORMED_JSON', 'Request body is not valid JSON.');
        }
        parsed = true;
      }
      return cached as T;
    }
    return {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      correlationId,
      requestId,
      json,
    };
  }

  function send(res: ServerResponse, result: HttpResult, requestId: string, correlationId: string): void {
    const headers: Record<string, string> = {
      'content-type': JSON_CONTENT_TYPE,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      'x-correlation-id': correlationId,
      ...(result.headers ?? {}),
    };
    const payload = result.body === undefined ? '' : JSON.stringify(result.body);
    res.writeHead(result.status, headers);
    res.end(payload);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startNs = process.hrtime.bigint();
    const requestId = randomUUID();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://${host}`);
    const correlationId = firstHeader(req.headers['x-correlation-id'])?.trim() || requestId;
    let status = 500;
    try {
      const ctx = buildContext(req, url, method, requestId, correlationId);
      const result = await dispatch(ctx);
      status = result.status;
      send(res, result, requestId, correlationId);
    } catch (err) {
      const result = errorToResult(err);
      status = result.status;
      if (status >= 500) {
        // Server-side only — the client sees just the code (see errorToResult).
        console.error(JSON.stringify({ msg: 'request_error', requestId, correlationId }), err);
      }
      send(res, result, requestId, correlationId);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      log({
        service: serviceName,
        method,
        path: url.pathname,
        status,
        durationMs: Math.round(durationMs * 1000) / 1000,
        requestId,
        correlationId,
      });
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  // Malformed request line / oversized headers: fail fast, no stack.
  server.on('clientError', (_err, socket) => {
    if (!socket.destroyed && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });

  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    if (stopping === undefined) {
      stopping = (async () => {
        // Release idle keep-alive sockets so close() can settle; in-flight
        // requests drain until the force-close timeout.
        server.closeIdleConnections();
        const forced = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
        forced.unref();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
        clearTimeout(forced);
        if (onShutdown) await onShutdown();
      })();
    }
    return stopping;
  }

  return new Promise<HttpServer>((resolve, reject) => {
    const onListenError = (err: Error): void => reject(err);
    server.once('error', onListenError);
    server.listen(port, host, () => {
      server.removeListener('error', onListenError);
      const address = server.address();
      const resolvedPort =
        address !== null && typeof address === 'object' ? (address as AddressInfo).port : port;
      const reachableHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

      if (handleSignals) {
        const shutdown = (): void => {
          void stop()
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
        };
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
      }

      resolve({ url: `http://${reachableHost}:${resolvedPort}`, port: resolvedPort, stop });
    });
  });
}
