// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — Public API (ADR-005)
//
//   Serve:   startHttpServer(options) → HttpServer
//   Route:   Route / RouteHandler / RequestContext / HttpResult
//   Errors:  throw new HttpError(status, code, detail?)
//
// Zero runtime dependencies — Node built-ins only.
// ══════════════════════════════════════════════════════════════════

export { startHttpServer } from './server.js';
export { HttpError } from './errors.js';
export type {
  AccessLogRecord,
  AccessLogger,
  HttpResult,
  HttpServer,
  HttpServerOptions,
  ReadinessProbe,
  RequestContext,
  Route,
  RouteHandler,
} from './types.js';
