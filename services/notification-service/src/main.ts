// ══════════════════════════════════════════════════════════════════
// notification-service — Runtime entrypoint (composition + bootstrap)
//
// A near-pure event reactor: consumes slot.assigned, delivers the invitation,
// emits notification.delivered + audit. Like audit-service it exposes NO
// business HTTP route — only /health and /ready — so orchestrators supervise
// it uniformly. Transport is env-selected: Kafka when KAFKA_BROKERS is set,
// else an in-memory bus (a reactor with no producers on that bus is a dev
// no-op, logged loudly).
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import { loadKafkaConfig } from '@usrp/shared-config';
import { startHttpServer } from '@usrp/shared-http';
import { createNotificationService } from './index.js';
import { loadNotificationConfig } from './config.js';
import { startSlotAssignedConsumer } from './adapters/events/slot-assigned.consumer.js';

function createEventBus(serviceName: string): EventBus {
  if (process.env['KAFKA_BROKERS']) {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail:
        'KAFKA_BROKERS unset — using in-memory event bus. notification-service reacts to nothing durable (no producers on this bus). Dev/tier1 only.',
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  const config = loadNotificationConfig();
  const bus = createEventBus(config.runtime.serviceName);
  await bus.connect();

  const service = createNotificationService(config, bus);

  // Subscribe BEFORE serving so a "ready" signal implies we are consuming.
  if (process.env['KAFKA_BROKERS']) {
    await startSlotAssignedConsumer(bus, service.deliver);
  }

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
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
      consuming: process.env['KAFKA_BROKERS'] ? 'slot.assigned' : 'none (in-memory bus)',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'notification-service' }), err);
  process.exit(1);
});
