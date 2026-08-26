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
//
// STARTUP IS PHASED AND BOUNDED, via the shared primitive in
// @usrp/shared-events. Consumer registration happens BEFORE the HTTP server
// starts — that ordering is the reason /ready means 'this reactor is actually
// consuming' and not merely 'this process is alive' — which also means a
// consumer that never finishes registering keeps the service invisible. Each
// registration is therefore announced before it is attempted and bounded while
// it runs.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import {
  InMemoryEventBus,
  KafkaEventBus,
  logStartupPhase,
  withStartupTimeout,
  type EventBus,
} from '@usrp/shared-events';
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

const SERVICE_NAME = 'notification-service';

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

async function main(): Promise<void> {
  logStartupPhase(SERVICE_NAME, 'asserting_production_secrets');
  assertProductionSecrets();

  logStartupPhase(SERVICE_NAME, 'loading_config');
  const config = loadNotificationConfig();

  logStartupPhase(SERVICE_NAME, 'resolving_event_transport');
  const transport = resolveEventTransport();

  const bus = createEventBus(config.runtime.serviceName, transport);

  logStartupPhase(SERVICE_NAME, 'connecting_event_bus', { transport: transport.kind });
  await withStartupTimeout(bus.connect(), 'connecting the event bus');
  logStartupPhase(SERVICE_NAME, 'event_bus_connected', { transport: transport.kind });

  const service = createNotificationService(config, bus, {
    resolver: new PgContactResolver(config.security.encryptionKey),
    sms: new LogSmsChannel(),
  });

  // Subscribe BEFORE serving so a "ready" signal implies we are consuming.
  // That invariant is load-bearing and is NOT relaxed by bounding these calls:
  // a registration that times out ends the process rather than letting it
  // serve /ready while consuming nothing.
  if (transport.kind === 'kafka') {
    logStartupPhase(SERVICE_NAME, 'starting_consumer', { topic: 'slot.assigned' });
    await withStartupTimeout(
      startSlotAssignedConsumer(bus, service.deliver),
      'starting the slot.assigned consumer',
    );

    logStartupPhase(SERVICE_NAME, 'starting_consumer', { topic: 'application.withdrawn' });
    await withStartupTimeout(
      startApplicationWithdrawnConsumer(bus, service.withdrawalNotice),
      'starting the application.withdrawn consumer',
    );

    logStartupPhase(SERVICE_NAME, 'consumers_started', {
      topics: 'slot.assigned, application.withdrawn',
    });
  }

  logStartupPhase(SERVICE_NAME, 'starting_http_server', { port: config.runtime.port });
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
  console.error(JSON.stringify({ msg: 'startup_failed', service: SERVICE_NAME }), err);
  process.exit(1);
});
