// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — Minimal HTTP server over node:http (ADR-005)
//
// A deliberately small, zero-dependency ingress substrate shared by every
// USRP service. It gives a hexagonal adapter exactly what it needs — typed
// routing, bounded body parsing, cookies, CORS, a uniform error shape,
// health/readiness, correlation-id propagation, one structured access-log
// line per request, and graceful shutdown — and nothing more. Business logic
// lives in the service core; this only moves bytes at the edge.
//
// THREE THINGS CHANGED WHEN THE EDGE TIER ARRIVED:
//
//   • Set-Cookie is emitted as a header ARRAY, so a response can carry the
//     session handle and the CSRF echo at once. Node's writeHead accepts
//     string[] for exactly this reason; a Record<string, string> never could.
//
//   • The ROUTE IS RESOLVED BEFORE THE CONTEXT IS BUILT, so the matched
//     route's body cap is what bounds the read. A cap negotiated after the
//     fact would be no cap at all.
//
//   • CORS preflight is answered HERE, never by a route, so a new endpoint
//     cannot ship without it.
//
// AND ONE THING CHANGED WHEN A GREEN PROBE ERASED A RED DIAGNOSIS: healthy
// probe traffic is no longer access-logged. See SILENT_WHEN_HEALTHY below.
// ══════════════════════════════════════════════════════════════════

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { parseCookieHeader, serializeSetCookie } from './cookies.js';
import { corsPreflightHeaders, corsResponseHeaders, isAllowedOrigin } from './cors.js';
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

/**
 * Reserved transport paths whose SUCCESSFUL responses are not access-logged.
 *
 * These are polled forever — every 2s by scripts/verify-dev-boot.sh, every
 * few seconds by a Kubernetes probe for a pod's entire life. Logging each
 * 200 buys nothing and costs two real things:
 *
 *   1. It buries genuine request traffic in retention and in `grep`.
 *   2. It DESTROYS EVIDENCE. The dev-boot proof reports failure by tailing
 *      200 lines of a shared log. Ten healthy services probed for the full
 *      600s deadline emit thousands of 200s, which pushed the hanging
 *      service's startup error out of that window entirely and turned a
 *      specific fault into 'never answered /ready or /health on :4003'.
 *
 * A NON-2xx probe is NOT silenced — a 503 from a readiness callback means the
 * process is up and declaring itself unfit, which is exactly the state an
 * operator must see. Silencing by path alone would have hidden that too.
 */
const SILENT_WHEN_HEALTHY: ReadonlySet<string> = new Set(['/health', '/ready']);

/** A matched route plus the byte cap that route is allowed to spend. */
interface RouteEntry {
  readonly handler: RouteHandler;
  readonly maxBodyBytes: number;
}

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

/** Union two comma-separated header lists without duplicating entries. */
function mergeVary(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const seen = new Set<string>();
  for (const token of `${a},${b}`.split(',')) {
    const trimmed = token.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen].join(', ');
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
  const cors = options.cors;
  const log = options.logger ?? defaultAccessLogger;

  // path → (method → entry)
  const table = new Map<string, Map<string, RouteEntry>>();
  for (const route of routes) {
    const method = route.method.toUpperCase();
    const byMethod = table.get(route.path) ?? new Map<string, RouteEntry>();
    byMethod.set(method, {
      handler: route.handler,
      maxBodyBytes: route.maxBodyBytes ?? maxBodyBytes,
    });
    table.set(route.path, byMethod);
  }

  function buildContext(
    req: IncomingMessage,
    url: URL,
    method: string,
    requestId: string,
    correlationId: string,
    routeMaxBodyBytes: number,
  ): RequestContext {
    const contentType = (firstHeader(req.headers['content-type']) ?? '').toLowerCase();
    let rawCache: Buffer | undefined;
    let jsonCache: unknown;
    let jsonParsed = false;
    let jar: ReadonlyMap<string, string> | undefined;

    async function rawBody(): Promise<Buffer> {
      if (rawCache === undefined) {
        rawCache = await readBody(req, routeMaxBodyBytes);
      }
      return rawCache;
    }

    async function json<T = unknown>(): Promise<T> {
      if (!jsonParsed) {
        if (!contentType.includes('application/json')) {
          throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
        }
        const raw = await rawBody();
        if (raw.length === 0) {
          throw new HttpError(400, 'EMPTY_BODY', 'A JSON request body is required.');
        }
        try {
          jsonCache = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, 'MALFORMED_JSON', 'Request body is not valid JSON.');
        }
        jsonParsed = true;
      }
      return jsonCache as T;
    }

    return {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      contentType,
      // Lazy: most requests never look at cookies, and internal
      // service-to-service traffic carries none at all.
      get cookies(): ReadonlyMap<string, string> {
        if (jar === undefined) {
          jar = parseCookieHeader(firstHeader(req.headers.cookie));
        }
        return jar;
      },
      correlationId,
      requestId,
      rawBody,
      json,
    };
  }

  function send(
    res: ServerResponse,
    result: HttpResult,
    requestId: string,
    correlationId: string,
    baseHeaders: Readonly<Record<string, string>>,
  ): void {
    const headers: Record<string, string | string[]> = {
      'content-type': JSON_CONTENT_TYPE,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      'x-correlation-id': correlationId,
      ...baseHeaders,
      ...(result.headers ?? {}),
    };

    // `vary` is the one header both layers legitimately set: the CORS layer
    // needs Origin, a handler may add its own. A blind spread would drop one.
    const vary = mergeVary(baseHeaders['vary'], result.headers?.['vary']);
    if (vary !== undefined) headers['vary'] = vary;

    // Set-Cookie as an ARRAY — the whole reason cookies are a first-class
    // field. Serialization throws on a cookie a browser would silently drop.
    const cookies = result.cookies ?? [];
    if (cookies.length > 0) {
      headers['set-cookie'] = cookies.map(serializeSetCookie);
    }

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
    const origin = firstHeader(req.headers.origin);
    let status = 500;

    // CORS headers ride on EVERY response once a policy is configured —
    // including error responses, or the browser hides the real status behind
    // an opaque network failure and every 4xx looks like a CORS bug.
    let corsHeaders: Record<string, string> = {};
    if (cors !== undefined) {
      corsHeaders = isAllowedOrigin(cors, origin)
        ? corsResponseHeaders(cors, origin as string)
        : // Vary even on rejection: without it a shared cache can be poisoned
          // into replaying one origin's ACAO to a different origin.
          { vary: 'Origin' };
    }

    try {
      // ── CORS preflight: answered by the transport, never by a route ──
      if (
        cors !== undefined &&
        method === 'OPTIONS' &&
        firstHeader(req.headers['access-control-request-method']) !== undefined
      ) {
        const result: HttpResult = isAllowedOrigin(cors, origin)
          ? { status: 204, headers: corsPreflightHeaders(cors, origin as string) }
          : { status: 403, body: { error: 'ORIGIN_NOT_ALLOWED' } };
        status = result.status;
        send(res, result, requestId, correlationId, corsHeaders);
        return;
      }

      // ── Reserved transport routes ──
      if (method === 'GET' && url.pathname === '/health') {
        const result: HttpResult = { status: 200, body: { status: 'ok', service: serviceName } };
        status = result.status;
        send(res, result, requestId, correlationId, corsHeaders);
        return;
      }
      if (method === 'GET' && url.pathname === '/ready') {
        const ready = readiness ? await readiness() : true;
        const result: HttpResult = {
          status: ready ? 200 : 503,
          body: { status: ready ? 'ready' : 'not_ready', service: serviceName },
        };
        status = result.status;
        send(res, result, requestId, correlationId, corsHeaders);
        return;
      }

      // ── Route resolution BEFORE context construction, so the matched
      //    route's byte cap is what actually bounds the body read. ──
      const byMethod = table.get(url.pathname);
      if (byMethod === undefined) {
        throw new HttpError(404, 'NOT_FOUND', `No route for ${method} ${url.pathname}.`);
      }
      const entry = byMethod.get(method);
      if (entry === undefined) {
        const result: HttpResult = {
          status: 405,
          headers: { allow: [...byMethod.keys()].sort().join(', ') },
          body: { error: 'METHOD_NOT_ALLOWED', detail: `${method} is not allowed for ${url.pathname}.` },
        };
        status = result.status;
        send(res, result, requestId, correlationId, corsHeaders);
        return;
      }

      const ctx = buildContext(req, url, method, requestId, correlationId, entry.maxBodyBytes);
      const result = await entry.handler(ctx);
      status = result.status;
      send(res, result, requestId, correlationId, corsHeaders);
    } catch (err) {
      const result = errorToResult(err);
      status = result.status;
      if (status >= 500) {
        // Server-side only — the client sees just the code (see errorToResult).
        console.error(JSON.stringify({ msg: 'request_error', requestId, correlationId }), err);
      }
      send(res, result, requestId, correlationId, corsHeaders);
    } finally {
      // A healthy probe is the one request class that carries no information:
      // it is generated on a timer, forever, by tooling that already acts on
      // the status code it got back. Anything else — including an UNhealthy
      // probe — is logged exactly as before.
      const isHealthyProbe = SILENT_WHEN_HEALTHY.has(url.pathname) && status >= 200 && status < 300;
      if (!isHealthyProbe) {
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
