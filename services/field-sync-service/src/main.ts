// ══════════════════════════════════════════════════════════════════
// field-sync-service — Runtime entrypoint (composition + bootstrap)
//
// An officer-facing HTTP service that owns the offline physical-test score log.
// It exposes three officer-authenticated routes — enroll a device, batch-sync
// signed score records, resolve a conflict — writes physical_test_scores /
// field_devices, and emits field.score.captured. Transport is env-selected:
// Kafka when KAFKA_BROKERS is set, else an in-memory bus (dev only; the emitted
// event then reaches no consumer — logged loudly).
// load config → bus → assemble → serve → shut down cleanly.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import { loadKafkaConfig } from '@usrp/shared-config';
import { makeAuthVerifier } from '@usrp/shared-auth';
import { startHttpServer } from '@usrp/shared-http';
import { createFieldSyncService } from './index.js';
import { loadFieldSyncConfig } from './config.js';
import { enrollDeviceRoute } from './adapters/http/enroll-device.controller.js';
import { syncScoresRoute } from './adapters/http/sync-scores.controller.js';
import { resolveConflictRoute } from './adapters/http/resolve-conflict.controller.js';

function createEventBus(serviceName: string): EventBus {
  if (process.env['KAFKA_BROKERS']) {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail: 'KAFKA_BROKERS unset — using in-memory event bus (field.score.captured reaches no consumer). Dev/tier1 only.',
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  const config = loadFieldSyncConfig();
  const bus = createEventBus(config.runtime.serviceName);
  await bus.connect();

  const service = createFieldSyncService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: [
      enrollDeviceRoute(service.enrollDevice, verify),
      syncScoresRoute(service.syncFieldScores, verify),
      resolveConflictRoute(service.resolveConflict, verify),
    ],
    // Ready only when the database — the system-of-record — is reachable.
    readiness: async (): Promise<boolean> => {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    onShutdown: async (): Promise<void> => {
      console.log(JSON.stringify({ msg: 'service_stopping', service: config.runtime.serviceName }));
      await bus.disconnect();
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
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'field-sync-service' }), err);
  process.exit(1);
});
