// ══════════════════════════════════════════════════════════════════
// edge-gateway — Runtime entrypoint
//
// The ONE browser-facing process. It holds live credentials for every session,
// which makes it the highest-value target in the platform, so its boot is the
// strictest in the repo:
//
//   1. assertProductionSecrets() first, before any other statement. A process
//      carrying a published dev key refuses to start under NODE_ENV=production.
//   2. A SECOND, edge-specific refusal: insecure cookies in production. The
//      __Host- prefix requires Secure, so shared-http would refuse to serialize
//      the session cookie — auth would fail invisibly on every request instead
//      of loudly at boot. This is the one misconfiguration that breaks
//      everything while every probe stays green.
//   3. configureDatabase() with the ALREADY-VALIDATED config, so the lazy pool
//      never re-reads process.env behind the config layer's back.
//
// READINESS DISTINGUISHES EDGE READINESS FROM DEPENDENCY HEALTH:
//
//   session store  HARD. Without it no handle resolves, so the process cannot
//                  serve a single authenticated request. Not ready.
//   iam-service    also gates readiness, because login is the door to
//                  everything else — an edge that cannot authenticate anyone is
//                  not ready to take traffic, even though it is alive.
//   everything else NOT a readiness input. application-service being down must
//                  surface as a 503 on the affected operation, not as an edge
//                  that removes itself from the load balancer and takes the
//                  citizen portal down with it.
//
// The result is cached briefly: /ready is polled every 2s by
// scripts/verify-dev-boot.sh and by every orchestrator probe, and a probe that
// opens a socket to iam on each poll makes the health check a load source.
// ══════════════════════════════════════════════════════════════════

import { assertProductionSecrets } from '@usrp/shared-config';
import { configureDatabase, sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { auditEdgeStats } from './observability/audit-log.js';
import { createEdgeGateway } from './index.js';
import { loadEdgeGatewayConfig } from './config.js';

/** How long a readiness verdict is reused. Shorter than any sane probe interval. */
const READINESS_CACHE_MS = 3_000;
/** How often expired session rows are swept. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1_000;
/** How long a dead session row is kept before deletion. */
const SWEEP_GRACE_MS = 24 * 60 * 60 * 1_000;
/** How often the aggregate session counters are emitted. */
const STATS_INTERVAL_MS = 60 * 1_000;

async function iamReachable(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(new URL('/health', baseUrl), {
      method: 'GET',
      signal: controller.signal,
    });
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

  configureDatabase({
    url: config.database.url,
    maxConnections: config.database.maxConnections,
  });

  const gateway = createEdgeGateway(config);

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
      // A 503 from a readiness callback means "the process is up and declaring
      // itself unfit", which is exactly the state an operator must be able to
      // diagnose — so it says WHICH half failed.
      console.warn(
        JSON.stringify({
          msg: 'edge_not_ready',
          sessionStore: storeReady ? 'ok' : 'unreachable',
          iamService: iamReady ? 'ok' : 'unreachable',
        }),
      );
    }
    cachedReadiness = { at: now, ready };
    return ready;
  };

  const sweeper = setInterval(() => {
    void gateway.deps.sessions
      .deleteExpired(new Date(Date.now() - SWEEP_GRACE_MS))
      .then((deleted) => {
        if (deleted > 0) auditEdgeStats({ sessionsSwept: deleted });
      })
      .catch((err: unknown) => {
        console.error(JSON.stringify({ msg: 'edge_session_sweep_failed' }), err);
      });
  }, SWEEP_INTERVAL_MS);
  // unref so a pending timer never holds the process open during shutdown.
  sweeper.unref();

  const statsTimer = setInterval(() => {
    void gateway.deps.sessions
      .stats(new Date())
      .then((stats) => {
        auditEdgeStats({
          activeOfficerSessions: stats.activeOfficer,
          activeApplicantSessions: stats.activeApplicant,
          revokedSessions: stats.revoked,
          expiredSessions: stats.expired,
          rateLimitBuckets: gateway.deps.limiter.size(),
        });
      })
      .catch((err: unknown) => {
        console.error(JSON.stringify({ msg: 'edge_session_stats_failed' }), err);
      });
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
      cookies: config.session.secureCookies ? '__Host- (Secure)' : 'dev names (insecure http)',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'edge-gateway' }), err);
  process.exit(1);
});
