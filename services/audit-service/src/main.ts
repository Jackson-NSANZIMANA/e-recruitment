// ══════════════════════════════════════════════════════════════════
// audit-service — Runtime entrypoint (composition + bootstrap)
//
// A new service ARCHETYPE for USRP: a pure event SINK. Unlike identity/
// eligibility it exposes NO business HTTP route — it only consumes
// `audit.immutable` and appends to the immutable trail. It still runs an HTTP
// server, but solely for `/health` and `/ready` (liveness + DB reachability),
// so orchestrators (k8s, Compose healthchecks) can supervise it like any other.
//
// Transport is env-selected, same as the other services: with KAFKA_BROKERS
// set it consumes from real Kafka; without it, an in-memory bus keeps the
// process runnable on a tier1-only stack (it just records nothing durable —
// logged loudly). A sink with an in-memory bus is a no-op by design.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import { loadKafkaConfig } from '@usrp/shared-config';
import { startHttpServer } from '@usrp/shared-http';
import { createAuditWriter } from './index.js';
import { loadAuditConfig } from './config.js';
import { startAuditEntryConsumer } from './adapters/events/audit-entry.consumer.js';

function createEventBus(serviceName: string): EventBus {
  if (process.env['KAFKA_BROKERS']) {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail:
        'KAFKA_BROKERS unset — using in-memory event bus. The audit sink will record NOTHING durable (no producers on this bus). Dev/tier1 only.',
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  const config = loadAuditConfig();
  const bus = createEventBus(config.runtime.serviceName);
  await bus.connect();

  const writer = createAuditWriter();

  // The sink's ingress: subscribe BEFORE serving so a "ready" signal implies
  // we are actually consuming. Only meaningful with a real broker.
  if (process.env['KAFKA_BROKERS']) {
    await startAuditEntryConsumer(bus, writer);
  }

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    // No business routes — the trail is written ONLY off the event backbone.
    routes: [],
    // Ready only when the audit database — the trail's home — is reachable.
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
      consuming: process.env['KAFKA_BROKERS'] ? 'audit.immutable' : 'none (in-memory bus)',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'audit-service' }), err);
  process.exit(1);
});
