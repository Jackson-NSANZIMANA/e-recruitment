// ══════════════════════════════════════════════════════════════════
// audit-service — Runtime entrypoint (composition + bootstrap)
//
// A new service ARCHETYPE for USRP: a pure event SINK. Unlike identity/
// eligibility it exposes NO business HTTP route — it only consumes
// `audit.immutable` and appends to the immutable trail. It still runs an HTTP
// server, but solely for `/health` and `/ready` (liveness + DB reachability),
// so orchestrators (k8s, Compose healthchecks) can supervise it like any other.
//
// TRANSPORT IS RESOLVED BY @usrp/shared-config, NOT BY READING process.env HERE.
// With KAFKA_BROKERS set it consumes from real Kafka; without it, in DEVELOPMENT
// ONLY, an in-memory bus keeps the process runnable on a tier1-only stack (it
// records nothing durable — logged loudly). In PRODUCTION resolveEventTransport()
// throws instead of degrading, and this service is the reason it has to:
//
//   an audit SINK on an in-memory bus accepts every append and stores NOTHING,
//   while /health and /ready both stay green — readiness probes the DATABASE,
//   which is perfectly healthy; it is the INGRESS that is missing. The
//   append-only trail that rls/0007 enforces and Law N° 058/2021 requires would
//   be an empty table, and nothing in any log would look wrong.
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
import { createAuditWriter } from './index.js';
import { loadAuditConfig } from './config.js';
import { startAuditEntryConsumer } from './adapters/events/audit-entry.consumer.js';

function createEventBus(serviceName: string, transport: EventTransport): EventBus {
  if (transport.kind === 'kafka') {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }

  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail:
        'KAFKA_BROKERS unset — using in-memory event bus. The audit sink will record NOTHING durable (no producers on this bus). Dev/tier1 only.',
      reason: transport.reason,
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  // FIRST, before any other loader: die on a production config that still
  // carries dev key material, placeholder secrets, loopback endpoints or mock
  // G2G integrations — while this process still holds no database pool, no
  // socket and no consumer-group membership. A doomed boot that joins and
  // leaves a consumer group perturbs the healthy replicas on its way down.
  assertProductionSecrets();

  const config = loadAuditConfig();
  const transport = resolveEventTransport();
  const bus = createEventBus(config.runtime.serviceName, transport);
  await bus.connect();

  const writer = createAuditWriter();

  // The sink's ingress: subscribe BEFORE serving so a "ready" signal implies
  // we are actually consuming. Only meaningful with a real broker.
  if (transport.kind === 'kafka') {
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
      consuming: transport.kind === 'kafka' ? 'audit.immutable' : 'none (in-memory bus)',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'audit-service' }), err);
  process.exit(1);
});
