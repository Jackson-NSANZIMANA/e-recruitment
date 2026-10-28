// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — ONE dependency-free server mounting every simulator
// (ADR-047 §3.2), on @usrp/shared-http.
//
// Per request: match a module → authorize → per-client token bucket (429) →
// behaviour (persona default, or `x-usrp-sandbox-behaviour`) → latency →
// fault or answer. Every response, including /health and 404s, carries
// `x-usrp-sandbox: 1` (fence 1, ADR-047 §3.1).
// ══════════════════════════════════════════════════════════════════

import { startHttpServer, type HttpResult, type HttpServer, type RequestContext } from '@usrp/shared-http';
import { SANDBOX_RESPONSE_HEADER, type UsrpEnvironment } from '@usrp/shared-config';
import {
  BEHAVIOUR_HEADER,
  DEFAULT_PROFILES,
  RETRY_AFTER_SECONDS,
  requestedBehaviour,
  sampleLatencyMs,
  TokenBuckets,
  type AuthorityProfile,
} from './behaviour.js';
import { personaBehaviour, subjectLabel, type SandboxWorld, type SimRequest, type SimResponse, type SimulatorModule } from './module.js';
import type { Authority, BehaviourName } from './population/model.js';
import { MODULES } from './modules/index.js';

export interface SandboxServerOptions {
  readonly world: SandboxWorld;
  readonly environment: UsrpEnvironment;
  readonly port: number;
  readonly host?: string;
  readonly modules?: readonly SimulatorModule[];
  readonly profiles?: Readonly<Record<Authority, AuthorityProfile>>;
  /** Multiplies every sampled latency; 0 disables latency (tests, CI). */
  readonly latencyScale?: number;
  /** How long the `timeout` behaviour holds a request before a 504. */
  readonly timeoutHoldMs?: number;
  readonly random?: () => number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function toHttp(response: SimResponse): HttpResult {
  const headers: Record<string, string> = { ...(response.headers ?? {}) };
  if (response.raw !== undefined) {
    headers['content-type'] = response.contentType ?? 'application/json';
    return { status: response.status, rawBody: response.raw, headers };
  }
  if (response.contentType !== undefined) headers['content-type'] = response.contentType;
  return { status: response.status, body: response.json ?? null, headers };
}

function simRequest(ctx: RequestContext): SimRequest {
  return {
    method: ctx.method,
    path: ctx.path,
    query: ctx.query,
    header: (name): string | null => {
      const value = ctx.headers[name.toLowerCase()];
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    },
    body: () => ctx.rawBody(),
  };
}

export function createSandboxServer(options: SandboxServerOptions): Promise<HttpServer> {
  const modules = options.modules ?? MODULES;
  const profiles = options.profiles ?? DEFAULT_PROFILES;
  const buckets = new TokenBuckets(profiles);
  const random = options.random ?? Math.random;
  const scale = options.latencyScale ?? 1;
  const world = options.world;
  // NESA's public response shape can serve a private owner persona. Never expose
  // it beyond loopback, even when a caller asks this server to bind wildcard.
  const bindHost = world.overlay !== null || options.environment === 'sandbox'
    ? '127.0.0.1'
    : options.host;

  async function dispatch(ctx: RequestContext): Promise<HttpResult | null> {
    const module = modules.find((m) => m.matches(ctx.method.toUpperCase(), ctx.path));
    if (module === undefined) return null;
    const started = Date.now();
    const req = simRequest(ctx);
    const auth = module.authorize(req, world);
    if (!('client' in auth)) {
      world.log.info('sim_refused', { module: module.id, status: auth.status });
      return toHttp(auth);
    }
    if (!buckets.take(module.authority, auth.client)) {
      world.log.info('sim_budget_exceeded', { module: module.id, status: 429 });
      const fault = module.fault('rate-limited', world);
      return toHttp({ ...fault, headers: { ...(fault.headers ?? {}), 'retry-after': '1' } });
    }
    const subject = module.subject(req, world);
    const behaviour: BehaviourName =
      requestedBehaviour(req.header(BEHAVIOUR_HEADER), module.authority) ?? personaBehaviour(subject, module.authority) ?? 'normal';
    const latency = sampleLatencyMs(profiles[module.authority], random, scale) * (behaviour === 'slow' ? 8 : 1);
    if (latency > 0) await sleep(latency);

    let response: SimResponse;
    switch (behaviour) {
      case 'rate-limited':
      case 'maintenance': {
        const fault = module.fault(behaviour, world);
        response = { ...fault, headers: { ...(fault.headers ?? {}), 'retry-after': String(RETRY_AFTER_SECONDS[behaviour]) } };
        break;
      }
      case 'status-false':
        response = module.fault('status-false', world);
        break;
      case 'timeout':
        await sleep(options.timeoutHoldMs ?? 65_000);
        response = { status: 504, json: { message: 'Gateway timeout' } };
        break;
      case 'truncated': {
        const full = await module.handle(req, subject, world);
        const text = full.raw ?? JSON.stringify(full.json ?? null);
        response = { status: full.status, raw: text.slice(0, Math.max(1, Math.floor(text.length / 2))), contentType: 'application/json' };
        break;
      }
      case 'normal':
      case 'slow':
        response = await module.handle(req, subject, world);
        break;
    }
    world.log.info('sim_answered', { module: module.id, status: response.status, persona: subjectLabel(subject), behaviour, durationMs: Date.now() - started });
    return toHttp(response);
  }

  return startHttpServer({
    serviceName: 'g2g-sandbox',
    port: options.port,
    ...(bindHost === undefined ? {} : { host: bindHost }),
    routes: [],
    fallback: dispatch,
    responseHeaders: { [SANDBOX_RESPONSE_HEADER]: '1' },
    // Access log: path only (never the query string, which can carry an index number).
    logger: (record) => { world.log.info('http', { method: record.method, status: record.status, durationMs: record.durationMs }); },
    version: { contract: { environment: options.environment, modules: modules.length } },
  });
}
