// ══════════════════════════════════════════════════════════════════
// notification-service — Runtime entrypoint (composition + bootstrap)
//
// A near-pure event reactor: consumes slot.assigned, delivers the invitation,
// emits notification.delivered + audit. Like audit-service it exposes NO
// business HTTP route — only /health and /ready — so orchestrators supervise
// it uniformly. Transport is resolved by @usrp/shared-config: Kafka when
// KAFKA_BROKERS is set, else an in-memory bus in DEVELOPMENT only (a reactor
// with no producers on that bus is a no-op, logged loudly). In production that
// no-op means a citizen is expected at an exam venue they were never told about.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import {
  assertProductionSecrets,
  loadKafkaConfig,
  resolveEventTransport,
  type EventTransport,
} from '@usrp/shared-config';
import { startHttpServer } from '@usrp/shared-http';
import { LogSmsChannel } from '@usrp/shared-sms';
import { createNotificationService } from './index.js';
import { PgContactResolver } from './adapters/contact.pg-resolver.js';
import { loadNotificationConfig } from './config.js';
import { startSlotAssignedConsumer } from './adapters/events/slot-assigned.consumer.js';
import { startApplicationWithdrawnConsumer } from './adapters/events/application-withdrawn.consumer.js';

const STARTUP_TIMEOUT_MS = 30_000;

function createEventBus(serviceName: string, transport: EventTransport): EventBus {
  if (transport.kind === 'kafka') {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail:
        'KAFKA_BROKERS unset — using in-memory event bus. notification-service reacts to nothing durable (no producers on this bus). Dev/tier1 only.',
      reason: transport.reason,
    }),
  );
  return new InMemoryEventBus();
}

async function withStartupTimeout<T>(operation: Promise<T>, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`notification-service startup timed out while ${step} after ${STARTUP_TIMEOUT_MS}ms`));
        }, STARTUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ msg: 'startup_begin', service: 'notification-service' }));
  assertProductionSecrets();

  const config = loadNotificationConfig();
  const transport = resolveEventTransport();
  const bus = createEventBus(config.runtime.serviceName, transport);

  console.log(JSON.stringify({ msg: 'notification_event_bus_connecting', transport: transport.kind }));
  await withStartupTimeout(bus.connect(), 'connecting to the event bus');
  console.log(JSON.stringify({ msg: 'notification_event_bus_connected', transport: transport.kind }));

  const service = createNotificationService(config, bus, {
    resolver: new PgContactResolver(config.security.encryptionKey),
    sms: new LogSmsChannel(),
  });

  // Subscribe BEFORE serving so a "ready" signal implies we are consuming.
  if (transport.kind === 'kafka') {
    console.log(JSON.stringify({ msg: 'notification_consumer_starting', topic: 'slot.assigned' }));
    await withStartupTimeout(
      startSlotAssignedConsumer(bus, service.deliver),
      'starting the slot.assigned consumer',
    );
    console.log(JSON.stringify({ msg: 'notification_consumer_started', topic: 'slot.assigned' }));

    console.log(JSON.stringify({ msg: 'notification_consumer_starting', topic: 'application.withdrawn' }));
    await withStartupTimeout(
      startApplicationWithdrawnConsumer(bus, service.withdrawalNotice),
      'starting the application.withdrawn consumer',
    );
    console.log(JSON.stringify({ msg: 'notification_consumer_started', topic: 'application.withdrawn' }));
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
      consuming:
        transport.kind === 'kafka' ? 'slot.assigned, application.withdrawn' : 'none (in-memory bus)',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'notification-service' }), err);
  process.exit(1);
});
