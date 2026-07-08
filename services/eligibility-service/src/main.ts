// ══════════════════════════════════════════════════════════════════
// eligibility-service — Runtime entrypoint (composition + bootstrap)
//
// The second runnable USRP service, following the identity-service
// template exactly: load config → build the event bus → assemble the use
// case → serve over HTTP (ADR-005) → shut down cleanly. Transport is
// chosen by environment (Kafka when KAFKA_BROKERS is set, else in-memory).
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import { loadKafkaConfig } from '@usrp/shared-config';
import { startHttpServer } from '@usrp/shared-http';
import { createEligibilityService } from './index.js';
import { loadEligibilityConfig } from './config.js';
import { ageEligibilityRoute } from './adapters/http/eligibility.controller.js';
import { educationCheckRoute } from './adapters/http/education.controller.js';
import { degreeCheckRoute } from './adapters/http/degree.controller.js';
import { startApplicantSubmittedConsumer } from './adapters/events/applicant-submitted.consumer.js';

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
  const config = loadEligibilityConfig();
  const bus = createEventBus(config.runtime.serviceName);
  await bus.connect();

  const services = createEligibilityService(config, bus);

  // Event-driven ingress: when a broker is configured, auto-run the age gate
  // off applicant.submitted. (In-memory bus has no cross-process delivery, so
  // this is only meaningful with real Kafka.) The NESA education gate has no
  // event trigger yet — it is driven synchronously over HTTP (event-driven
  // NESA is a follow-on slice; see the education slice docs).
  if (process.env['KAFKA_BROKERS']) {
    await startApplicantSubmittedConsumer(bus, services.age);
    console.log(JSON.stringify({ msg: 'event_consumer_started', topic: 'applicant.submitted' }));
  }

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: [
      ageEligibilityRoute(services.age),
      educationCheckRoute(services.education),
      degreeCheckRoute(services.degree),
    ],
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
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'eligibility-service' }), err);
  process.exit(1);
});
