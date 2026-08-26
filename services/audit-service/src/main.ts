// ══════════════════════════════════════════════════════════════════
// audit-service — Runtime entrypoint (composition + bootstrap)
//
// A new service ARCHETYPE for USRP: a pure event SINK. Unlike identity/
// eligibility it exposes NO business HTTP route — it only consumes
// `audit.immutable` and appends to the immutable trail. It still runs an
// HTTP server, but solely for `/health` and `/ready` (liveness + DB reachability),
// so orchestrators (k8s, Compose healthchecks) can supervise it like any other.
//
// TRANSPORT IS RESOLVED BY @usrp/shared-config, NOT BY READING process.env HERE.
// With KAFKA_BROKERS set it consumes from real Kafka; without it, in DEVELOPMENT
// ONLY, an in-memory bus keeps the process runnable on a tier1-only stack (it
// records nothing durable — logged loudly). In PRODUCTION resolveEventTransport()
// throws instead of degrading.
//
// STARTUP IS PHASED AND BOUNDED. The boot proof can only report a missing port;
// without markers that symptom does not identify whether config, Kafka, or the
// HTTP bind failed. Each marker is emitted BEFORE its phase, and the transport
// operations use the shared 30-second startup bound. The sink still subscribes
// BEFORE serving, so /ready means the consumer is actually attached.
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
import { createAuditWriter } from './index.js';
import { loadAuditConfig } from './config.js';
import { startAuditEntryConsumer } from './adapters/events/audit-entry.consumer.js';

const SERVICE_NAME = 'audit-service';

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
  logStartupPhase(SERVICE_NAME, 'asserting_production_secrets');
  assertProductionSecrets();

  logStartupPhase(SERVICE_NAME, 'loading_config');
  const config = loadAuditConfig();

  logStartupPhase(SERVICE_NAME, 'resolving_event_transport');
  const transport = resolveEventTransport();
  const bus = createEventBus(config.runtime.serviceName, transport);

  logStartupPhase(SERVICE_NAME, 'connecting_event_bus', { transport: transport.kind });
  await withStartupTimeout(bus.connect(), 'connecting the event bus');

  logStartupPhase(SERVICE_NAME, 'building_audit_writer');
  const writer = createAuditWriter();

  if (transport.kind === 'kafka') {
    logStartupPhase(SERVICE_NAME, 'starting_consumer', { topic: 'audit.immutable' });
    await withStartupTimeout(
      startAuditEntryConsumer(bus, writer),
      'starting the audit.immutable consumer',
    );
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
      consuming: transport.kind === 'kafka' ? 'audit.immutable' : 'none (in-memory bus)',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: SERVICE_NAME }), err);
  process.exit(1);
});
