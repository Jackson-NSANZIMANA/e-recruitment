// ══════════════════════════════════════════════════════════════════
// scheduling-service — Runtime entrypoint (composition + bootstrap)
//
// A pure event-driven stage gate: it consumes APPLICATION_ELIGIBILITY_CLEARED,
// resolves the applicant's home district to an exam venue, and emits
// SLOT_ASSIGNED + AUDIT_ENTRY. It backs a datastore only to READ (identity PII
// + venue reference data); it never writes application state — application-
// service's projection applies the SLOT_ASSIGNED it emits (ADR-006). It runs an
// HTTP server solely for /health + /ready so orchestrators can supervise it.
//
// Transport is env-selected: with KAFKA_BROKERS set it consumes from real Kafka;
// without it, an in-memory bus keeps the process runnable but there are no
// cross-process events to react to — logged loudly.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import { loadKafkaConfig } from '@usrp/shared-config';
import { startHttpServer } from '@usrp/shared-http';
import { createSchedulingService } from './index.js';
import { loadSchedulingConfig } from './config.js';
import { startApplicationClearedConsumer } from './adapters/events/application-cleared.consumer.js';

function createEventBus(serviceName: string): EventBus {
  if (process.env['KAFKA_BROKERS']) {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail:
        'KAFKA_BROKERS unset — using in-memory event bus. The scheduling gate has no cross-process trigger to react to. Dev/tier1 only.',
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  const config = loadSchedulingConfig();
  const bus = createEventBus(config.runtime.serviceName);
  await bus.connect();

  const service = createSchedulingService(config, bus);

  // The gate's ingress: subscribe BEFORE serving so a "ready" signal implies we
  // are actually consuming. Only meaningful with a real broker.
  if (process.env['KAFKA_BROKERS']) {
    await startApplicationClearedConsumer(bus, service.assignSlot);
    console.log(JSON.stringify({ msg: 'event_consumer_started', topic: 'application.cleared' }));
  }

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    // No business routes — scheduling runs ONLY off the event backbone.
    routes: [],
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
      consuming: process.env['KAFKA_BROKERS'] ? 'application.cleared' : 'none (in-memory bus)',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'scheduling-service' }), err);
  process.exit(1);
});
