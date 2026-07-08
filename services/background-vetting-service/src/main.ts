// ══════════════════════════════════════════════════════════════════
// background-vetting-service — Runtime entrypoint (composition + bootstrap)
//
// A pure event-driven vetting gate, and the platform's first DB-FREE service:
// it consumes APPLICANT_SUBMITTED, calls the RIB registry over G2G, and emits
// RIB_VETTING_COMPLETED + AUDIT_ENTRY. It holds no datastore — the applicant
// key it needs (nationalIdHash) rides in on the event, and its verdicts leave
// as events. It still runs an HTTP server, but solely for /health + /ready so
// orchestrators (k8s, Compose healthchecks) can supervise it like any service.
//
// Transport is env-selected, same as every other service: with KAFKA_BROKERS
// set it consumes from real Kafka; without it, an in-memory bus keeps the
// process runnable but there are no cross-process events to react to — logged
// loudly. An event-driven gate on an in-memory bus is a no-op by design.
// ══════════════════════════════════════════════════════════════════

import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import { loadKafkaConfig } from '@usrp/shared-config';
import { startHttpServer } from '@usrp/shared-http';
import { createBackgroundVettingService } from './index.js';
import { loadBackgroundVettingConfig } from './config.js';
import { startApplicantSubmittedConsumer } from './adapters/events/applicant-submitted.consumer.js';

function createEventBus(serviceName: string): EventBus {
  if (process.env['KAFKA_BROKERS']) {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail:
        'KAFKA_BROKERS unset — using in-memory event bus. The vetting gate has no cross-process trigger to react to. Dev/tier1 only.',
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  const config = loadBackgroundVettingConfig();
  const bus = createEventBus(config.runtime.serviceName);
  await bus.connect();

  const service = createBackgroundVettingService(config, bus);

  // The gate's ingress: subscribe BEFORE serving so a "ready" signal implies
  // we are actually consuming. Only meaningful with a real broker.
  if (process.env['KAFKA_BROKERS']) {
    await startApplicantSubmittedConsumer(bus, service.criminalClearance);
    console.log(JSON.stringify({ msg: 'event_consumer_started', topic: 'applicant.submitted' }));
  }

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    // No business routes — vetting runs ONLY off the event backbone.
    routes: [],
    // This service backs no datastore: readiness is the liveness of the
    // process with its consumer subscribed (done above before we serve). RIB
    // reachability is deliberately NOT gated here — a transient RIB outage
    // must not mark us unready; the consumer keeps the offset uncommitted and
    // retries, rather than dropping the service from rotation.
    readiness: async (): Promise<boolean> => true,
    onShutdown: async (): Promise<void> => {
      console.log(JSON.stringify({ msg: 'service_stopping', service: config.runtime.serviceName }));
      await bus.disconnect();
      console.log(JSON.stringify({ msg: 'service_stopped', service: config.runtime.serviceName }));
    },
  });

  console.log(
    JSON.stringify({
      msg: 'service_started',
      service: config.runtime.serviceName,
      url: server.url,
      env: config.runtime.nodeEnv,
      consuming: process.env['KAFKA_BROKERS'] ? 'applicant.submitted' : 'none (in-memory bus)',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'background-vetting-service' }), err);
  process.exit(1);
});
