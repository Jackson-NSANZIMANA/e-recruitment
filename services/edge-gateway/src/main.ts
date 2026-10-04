// ══════════════════════════════════════════════════════════════════
// edge-gateway — Runtime entrypoint
//
// The ONE browser-facing process. It holds live credentials for every session,
// which makes it the highest-value target in the platform, so its boot is the
// strictest in the repo:
//
//   1. assertProductionSecrets() first, before any other statement. A process
//      carrying a published dev key refuses to start under NODE_ENV=production.
//   2. Edge-specific refusals (insecure cookies in production; see below).
//   3. configureDatabase() with the ALREADY-VALIDATED config, so the lazy pool
//      never re-reads process.env behind the config layer's back.
//
// READINESS: the session store and iam-service gate readiness; every other
// upstream surfaces as a 503 on the affected operation instead.
//
// LOGGING: every line written after boot goes through deps.audit (redacting).
// The only direct console writes are the start/stop/startup-failure lines
// below, which carry no request data. verify-edge-hygiene.ts pins that.
// ══════════════════════════════════════════════════════════════════

import { assertProductionSecrets } from '@usrp/shared-config';
import { configureDatabase, sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { createEdgeGateway } from './index.js';
import { loadEdgeGatewayConfig } from './config.js';

/** How long a readiness verdict is reused. Shorter than any sane probe interval. */
const READINESS_CACHE_MS = 3_000;
/** How often expired session rows and rate-limit windows are swept. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1_000;
/** How long a dead session row is kept before deletion. */
const SWEEP_GRACE_MS = 24 * 60 * 60 * 1_000;
/** How often the aggregate counters are emitted. */
const STATS_INTERVAL_MS = 60 * 1_000;

async function iamReachable(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(new URL('/health', baseUrl), { method: 'GET', signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(deadline);
  }
}

async function main(): Promise<void> {
  assertProductionSecrets();

  const config = loadEdgeGatewayConfig();

  if (config.runtime.isProduction && !config.session.secureCookies) {
    throw new Error(
      'EDGE_COOKIE_SECURE=false in production. The __Host- cookie prefix requires Secure, so ' +
        'shared-http would refuse to serialize the session cookie and every login would fail ' +
        'while /health and /ready stayed green. Refusing to boot.',
    );
  }

  configureDatabase({ url: config.database.url, maxConnections: config.database.maxConnections });

  const gateway = createEdgeGateway(config);
  const { audit } = gateway.deps;

  let cachedReadiness = { at: 0, ready: false };
  const readiness = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - cachedReadiness.at < READINESS_CACHE_MS) return cachedReadiness.ready;

    let storeReady = false;
    try {
      await sql`SELECT 1`;
      storeReady = true;
    } catch {
      storeReady = false;
    }
    const iamReady = storeReady ? await iamReachable(config.upstream.iamBaseUrl) : false;
    const ready = storeReady && iamReady;
    if (!ready) {
      audit.stats({ notReady: 1, sessionStoreReady: storeReady ? 1 : 0, iamServiceReady: iamReady ? 1 : 0 });
    }
    cachedReadiness = { at: now, ready };
    return ready;
  };

  const sweeper = setInterval(() => {
    const now = new Date();
    void gateway.deps.sessions
      .deleteExpired(new Date(now.getTime() - SWEEP_GRACE_MS))
      .then((deleted) => {
        if (deleted > 0) audit.stats({ sessionsSwept: deleted });
      })
      .catch((err: unknown) => audit.fault({ event: 'EDGE_SESSION_SWEEP_FAILED' }, err));
    void gateway.deps.limiter
      .sweep(now)
      .catch((err: unknown) => audit.fault({ event: 'EDGE_RATE_LIMITER_SWEEP_FAILED' }, err));
  }, SWEEP_INTERVAL_MS);
  // unref so a pending timer never holds the process open during shutdown.
  sweeper.unref();

  const statsTimer = setInterval(() => {
    const now = new Date();
    void Promise.all([gateway.deps.sessions.stats(now), gateway.deps.limiter.activeBuckets(now)])
      .then(([stats, buckets]) => {
        audit.stats({
          activeOfficerSessions: stats.activeOfficer,
          activeApplicantSessions: stats.activeApplicant,
          revokedSessions: stats.revoked,
          expiredSessions: stats.expired,
          rateLimitBuckets: buckets,
        });
      })
      .catch((err: unknown) => audit.fault({ event: 'EDGE_STATS_FAILED' }, err));
  }, STATS_INTERVAL_MS);
  statsTimer.unref();

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: gateway.routes,
    cors: gateway.cors,
    readiness,
    onShutdown: async (): Promise<void> => {
      console.log(JSON.stringify({ msg: 'service_stopping', service: config.runtime.serviceName }));
      clearInterval(sweeper);
      clearInterval(statsTimer);
      await sql.end({ timeout: 5 });
      console.log(JSON.stringify({ msg: 'service_stopped', service: config.runtime.serviceName }));
    },
  });

  console.log(
    JSON.stringify({
      msg: 'service_started',
      service: config.runtime.serviceName,
      url: server.url,
      env: config.runtime.nodeEnv,
      operations: gateway.routes.length,
      corsOrigins: config.cors.origins.length,
      rateLimitStore: gateway.deps.limiter.store,
      cookies: config.session.secureCookies ? '__Host- (Secure)' : 'dev names (insecure http)',
    }),
  );
}

main().catch((err: unknown) => {
  // Name and message, never the stack or the raw object. Boot errors are written
  // by the config loaders and the refusals above, which never echo a value.
  const error = err instanceof Error ? { name: err.name, message: err.message } : { name: typeof err };
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'edge-gateway', error }));
  process.exit(1);
});
