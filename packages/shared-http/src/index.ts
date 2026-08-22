// ══════════════════════════════════════════════════════════════════
// @usrp/shared-http — Public API (ADR-005)
//
//   Serve:   startHttpServer(options) → HttpServer
//   Route:   Route / RouteHandler / RequestContext / HttpResult
//   Cookies: HttpResult.cookies: SetCookie[] · ctx.cookies (parsed jar)
//   CORS:    HttpServerOptions.cors: CorsPolicy (edge tier only)
//   Errors:  throw new HttpError(status, code, detail?)
//
// Zero runtime dependencies — Node built-ins only.
// ══════════════════════════════════════════════════════════════════

export { startHttpServer } from './server.js';
export { HttpError } from './errors.js';
export {
  HOST_COOKIE_PREFIX,
  parseCookieHeader,
  serializeSetCookie,
  type CookieSameSite,
  type SetCookie,
} from './cookies.js';
export { corsPreflightHeaders, corsResponseHeaders, isAllowedOrigin } from './cors.js';
export type {
  AccessLogRecord,
  AccessLogger,
  CorsPolicy,
  HttpResult,
  HttpServer,
  HttpServerOptions,
  ReadinessProbe,
  RequestContext,
  Route,
  RouteHandler,
} from './types.js';
