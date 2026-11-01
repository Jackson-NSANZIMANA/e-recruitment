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
// Transport is resolved by @usrp/shared-config, same as every other service:
// with KAFKA_BROKERS set it consumes from real Kafka; without it, in
// DEVELOPMENT only, an in-memory bus keeps the process runnable but there are
// no cross-process events to react to — logged loudly. An event-driven gate on
// an in-memory bus is a no-op by design, which in production would mean no
// applicant is ever criminal-record checked while the service reports healthy.
// ══════════════════════════════════════════════════════════════════

import { InMemoryEventBus, KafkaEventBus, type DeadLetterObserver, type EventBus } from '@usrp/shared-events';
import {
  assertProductionSecrets,
  loadKafkaConfig,
  resolveEventTransport,
  type EventTransport,
} from '@usrp/shared-config';
import { startHttpServer } from '@usrp/shared-http';
import { createBackgroundVettingService, createClearanceCertificateService } from './index.js';
import { loadBackgroundVettingConfig, loadClearanceCertificateConfig } from './config.js';
import { startApplicantSubmittedConsumer } from './adapters/events/applicant-submitted.consumer.js';
import { startClearanceCertificateConsumer } from './adapters/events/clearance-certificate-submitted.consumer.js';
import { clearanceDeadLetterObserver } from './adapters/events/clearance-dead-letter.observer.js';

/**
 * `resolveObserver` is lazy on purpose: the dead-letter observer needs the
 * clearance use case, and the use case needs the bus. Nothing can be dead-
 * lettered before the first message is consumed, which happens after main() has
 * wired both, so resolving at the first dead letter is safe and keeps the
 * dependency one-directional.
 */
function createEventBus(
  serviceName: string,
  transport: EventTransport,
  resolveObserver: () => DeadLetterObserver | null,
): EventBus {
  if (transport.kind === 'kafka') {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({
      brokers: kafka.brokers,
      clientId: kafka.clientId,
      ssl: kafka.ssl,
      // What a permanent failure MEANS is the consumer's call, not the bus's:
      // see dead-letter.ts and clearance-dead-letter.observer.ts.
      onDeadLetter: async (event, info): Promise<void> => {
        const observer = resolveObserver();
        if (observer === null) return;
        await observer(event, info);
      },
    });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail:
        'KAFKA_BROKERS unset — using in-memory event bus. The vetting gate has no cross-process trigger to react to. Dev/tier1 only.',
      reason: transport.reason,
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  assertProductionSecrets();

  const config = loadBackgroundVettingConfig();
  const transport = resolveEventTransport();
  let deadLetterObserver: DeadLetterObserver | null = null;
  const bus = createEventBus(config.runtime.serviceName, transport, () => deadLetterObserver);
  await bus.connect();

  // The gate's ingress: subscribe BEFORE serving so a "ready" signal implies
  // we are actually consuming. Only meaningful with a real broker.
  //   RIB_HASH            applicant.submitted → RIB by nationalIdHash (DB-free)
  //   IREMBO_CERTIFICATE  clearance.submitted → the Irembo certificate flow
  //                       (ADR-048 §2.3). The applicant gives the number after
  //                       submitting, so nothing runs on applicant.submitted.
  let consuming = 'none (in-memory bus)';
  if (config.mode === 'IREMBO_CERTIFICATE') {
    const clearance = createClearanceCertificateService(loadClearanceCertificateConfig(), bus);
    // A registry outage longer than the retry budget ends in a HUMAN, not in a
    // PENDING row nobody looks at (evaluation D2).
    deadLetterObserver = clearanceDeadLetterObserver(clearance);
    if (transport.kind === 'kafka') {
      await startClearanceCertificateConsumer(bus, clearance);
      consuming = 'clearance.submitted';
      console.log(JSON.stringify({ msg: 'event_consumer_started', topic: 'clearance.submitted', mode: config.mode }));
    }
  } else {
    const service = createBackgroundVettingService(config, bus);
    if (transport.kind === 'kafka') {
      await startApplicantSubmittedConsumer(bus, service.criminalClearance);
      consuming = 'applicant.submitted';
      console.log(JSON.stringify({ msg: 'event_consumer_started', topic: 'applicant.submitted', mode: config.mode }));
    }
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
    readiness: (): Promise<boolean> => Promise.resolve(true),
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
      mode: config.mode,
      consuming,
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'background-vetting-service' }), err);
  process.exit(1);
});
