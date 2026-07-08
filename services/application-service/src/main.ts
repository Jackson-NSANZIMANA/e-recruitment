// ══════════════════════════════════════════════════════════════════
// application-service — Runtime entrypoint (composition + bootstrap)
//
// THE FRONT DOOR process: it composes the hexagonal core with a real event
// transport and exposes it over HTTP (ADR-005): load config → build the
// event bus → assemble the use case → serve → shut down cleanly. It is a
// pure producer — POST /v1/applications files an application and publishes
// APPLICANT_SUBMITTED; it consumes no topic.
//
// Transport is chosen by environment: with KAFKA_BROKERS set we publish to
// Kafka (prod/tier2); without it we fall back to an in-memory bus so the
// service still runs on a tier1-only dev stack (events are then local-only
// — logged loudly so this is never mistaken for durable publishing).
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import { loadKafkaConfig } from '@usrp/shared-config';
import { startHttpServer } from '@usrp/shared-http';
import { createApplicationService } from './index.js';
import { loadApplicationConfig } from './config.js';
import { submitApplicationRoute } from './adapters/http/submit-application.controller.js';

function createEventBus(serviceName: string): EventBus {
  if (process.env['KAFKA_BROKERS']) {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail: 'KAFKA_BROKERS unset — using in-memory event bus (events are NOT durably published). Dev/tier1 only.',
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  const config = loadApplicationConfig();
  const bus = createEventBus(config.runtime.serviceName);
  await bus.connect();

  const service = createApplicationService(config, bus);

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: [submitApplicationRoute(service)],
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
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'application-service' }), err);
  process.exit(1);
});
