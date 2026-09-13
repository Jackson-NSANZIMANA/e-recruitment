// ══════════════════════════════════════════════════════════════════
// edge-gateway — Runtime entrypoint
//
// THE ONLY BROWSER-FACING PROCESS IN THE PLATFORM, which shows up here in three
// ways no internal service has:
//
//   • CORS is configured. Every other service leaves it unset and emits no CORS
//     headers at all, because a service no browser reaches should not have a
//     cross-origin policy to get wrong.
//   • The readiness probe is REAL. It checks the session store and iam-service,
//     and returns 503 when either is unavailable. biometric-service was found
//     returning 200 unconditionally because it passes no callback, which makes a
//     readiness probe decorative: the orchestrator routes traffic to a process
//     that cannot serve it.
//   • It refuses to start with insecure cookies in production. `__Host-` requires
//     Secure, so EDGE_COOKIE_SECURE=false in production would mean browsers
//     silently dropping the session cookie — a total, unexplainable auth outage.
//     Better to fail at boot with a sentence than at 3am with a mystery.
//
// No event bus: the edge owns no state and publishes no domain events. Audit for
// browser-originated actions is written by the services that perform them, off
// the correlation id this process threads through.
// ══════════════════════════════════════════════════════════════════

import { assertProductionSecrets } from '@usrp/shared-config';
import { sql } from '@usrp/shared-database';
import { startHttpServer } from '@usrp/shared-http';
import { createEdgeGateway } from './index.js';
import { loadEdgeGatewayConfig } from './config.js';
import { CSRF_HEADER } from './adapters/http/csrf.js';

/** How often expired rate-limit windows are dropped. */
const SWEEP_INTERVAL_MS = 60_000;
/** Upstream health probe timeout for the readiness check. */
const IAM_PROBE_TIMEOUT_MS = 2_000;

async function iamReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(IAM_PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  assertProductionSecrets();

  const config = loadEdgeGatewayConfig();

  if (config.runtime.isProduction && !config.session.secureCookies) {
    throw new Error(
      'EDGE_COOKIE_SECURE must be true in production: the __Host- cookie prefix requires Secure, ' +
        'and browsers SILENTLY DROP a __Host- cookie without it — every login would appear to ' +
        'succeed and no session would ever be sent back.',
    );
  }

  const edge = createEdgeGateway(config);
  const sweeper = setInterval(() => {
    edge.sweep();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: edge.routes,
    cors: {
      // Exact-match allow-list, never a pattern.
      origins: config.cors.origins,
      // Required: the whole tier is cookie-based.
      credentials: true,
      allowedMethods: ['GET', 'POST', 'OPTIONS'],
      // No `authorization`. There is no operation that accepts one and no code
      // path in the frontend transport that can add one — advertising it as
      // allowed would invite exactly the thing this tier exists to prevent.
      allowedHeaders: ['content-type', CSRF_HEADER, 'x-correlation-id'],
      exposedHeaders: ['x-correlation-id', 'x-request-id'],
    },
    readiness: async (): Promise<boolean> => {
      const [store, iam] = await Promise.all([
        edge.ready(),
        iamReachable(config.upstream.iamBaseUrl),
      ]);
      return store && iam;
    },
    onShutdown: async (): Promise<void> => {
      console.log(JSON.stringify({ msg: 'service_stopping', service: config.runtime.serviceName }));
      clearInterval(sweeper);
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
      routes: edge.routes.length,
      secureCookies: config.session.secureCookies,
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'edge-gateway' }), err);
  process.exit(1);
});
