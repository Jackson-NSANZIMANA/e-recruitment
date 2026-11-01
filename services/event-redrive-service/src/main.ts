// ══════════════════════════════════════════════════════════════════
// event-redrive-service — Runtime entrypoint (D2, ADR-050 §3.1)
//
// The 13th process, and the second pure "no business route" archetype after
// audit-service: it serves /health, /ready and /version and nothing else. It
// owns no domain state and makes no business decision — it reads dead letters,
// decides WHEN to knock again, and republishes bytes.
//
// KAFKA IS REQUIRED HERE, unlike in the sink: a re-driver with no broker has
// nothing to re-drive, so a silent in-memory fallback would report healthy
// while doing nothing. Production and sandbox both configure it; the boot
// fails loudly if it is absent.
//
// STARTUP IS PHASED AND BOUNDED (the platform marker idiom), and the WORKER
// starts only after the HTTP server is listening, so /ready never reports a
// process that is not actually in the loop.
// ══════════════════════════════════════════════════════════════════

import {
  bindHostAnnouncement,
  assertProductionSecrets,
  resolveHttpBindHost,
  resolveEventTransport,
} from '@usrp/shared-config';
import { logStartupPhase, withStartupTimeout } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import { createRedriveService, startRedriveWorker, type WorkerHandle } from './index.js';
import { loadEventRedriveConfig } from './config.js';

const SERVICE_NAME = 'event-redrive-service';

/**
 * Held at module scope because the HTTP server's shutdown hook closes over it
 * before the worker starts: the order in main() is server → publisher → worker,
 * and a SIGTERM during that sequence must still stop the worker if it exists.
 */
let worker: WorkerHandle | null = null;

async function main(): Promise<void> {
  logStartupPhase(SERVICE_NAME, 'asserting_production_secrets');
  assertProductionSecrets();

  logStartupPhase(SERVICE_NAME, 'loading_config');
  const config = loadEventRedriveConfig();

  logStartupPhase(SERVICE_NAME, 'resolving_event_transport');
  const transport = resolveEventTransport();
  if (transport.kind !== 'kafka') {
    // Deliberate: no broker means no letters, and a "healthy" re-driver that
    // moves nothing is worse than a process that refuses to start.
    throw new Error('event-redrive-service requires KAFKA_BROKERS: a re-driver without a broker re-drives nothing');
  }

  logStartupPhase(SERVICE_NAME, 'building_redrive_service');
  const composition = createRedriveService({ kafka: config.kafka });

  logStartupPhase(SERVICE_NAME, 'starting_http_server', { port: config.runtime.port });
  const bindHost = resolveHttpBindHost({ serviceName: config.runtime.serviceName });
  console.log(
    JSON.stringify(bindHostAnnouncement(config.runtime.serviceName, bindHost, config.runtime.port)),
  );

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    host: bindHost,
    routes: [],
    readiness: composition.readiness,
    onShutdown: async (): Promise<void> => {
      console.log(JSON.stringify({ msg: 'service_stopping', service: config.runtime.serviceName }));
      await worker?.stop();
      await composition.close();
      console.log(JSON.stringify({ msg: 'service_stopped', service: config.runtime.serviceName }));
    },
  });

  logStartupPhase(SERVICE_NAME, 'starting_worker', {
    tickIntervalMs: config.tickIntervalMs,
    schedule: config.policy.delaysMs,
  });
  await withStartupTimeout(composition.republisher.connect(), 'connecting the raw publisher');
  worker = await startRedriveWorker({
    service: composition.service,
    tickIntervalMs: config.tickIntervalMs,
    leaderLockKey: config.leaderLockKey,
    log: (line: Record<string, unknown>): void => {
      process.stdout.write(`${JSON.stringify(line)}\n`);
    },
  });

  console.log(
    JSON.stringify({
      msg: 'service_started',
      service: config.runtime.serviceName,
      url: server.url,
      env: config.runtime.nodeEnv,
      schedule: config.policy.delaysMs,
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: SERVICE_NAME }), err);
  process.exit(1);
});
