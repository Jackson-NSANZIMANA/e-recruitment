// ══════════════════════════════════════════════════════════════════
// eligibility-service — Runtime entrypoint (composition + bootstrap)
//
// The second runnable USRP service, following the identity-service
// template exactly: load config → build the event bus → assemble the use
// case → serve over HTTP (ADR-005) → shut down cleanly. Transport is
// resolved by @usrp/shared-config (Kafka when KAFKA_BROKERS is set, else an
// in-memory bus in DEVELOPMENT only).
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import {
  assertProductionSecrets,
  loadKafkaConfig,
  resolveEventTransport,
  type EventTransport,
} from '@usrp/shared-config';
import { makeAuthVerifier } from '@usrp/shared-auth';
import { startHttpServer } from '@usrp/shared-http';
import { createEligibilityService } from './index.js';
import { loadEligibilityConfig } from './config.js';
import { ageEligibilityRoute } from './adapters/http/eligibility.controller.js';
import { educationCheckRoute } from './adapters/http/education.controller.js';
import { degreeCheckRoute } from './adapters/http/degree.controller.js';
import { startApplicantSubmittedConsumer } from './adapters/events/applicant-submitted.consumer.js';
import { startAcademicVettingConsumer } from './adapters/events/academic-vetting.consumer.js';

function createEventBus(serviceName: string, transport: EventTransport): EventBus {
  if (transport.kind === 'kafka') {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail: 'KAFKA_BROKERS unset — using in-memory event bus (events are NOT durably published). Dev/tier1 only.',
      reason: transport.reason,
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  assertProductionSecrets();

  const config = loadEligibilityConfig();
  const transport = resolveEventTransport();
  const bus = createEventBus(config.runtime.serviceName, transport);
  await bus.connect();

  const services = createEligibilityService(config, bus);

  // Ingress auth: verify inbound bearer tokens with the issuer public key.
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  // Event-driven ingress: when a broker is configured, auto-run BOTH eligibility
  // gates off applicant.submitted — age (internal compute) and academic (NESA/HEC
  // over G2G), each in its own consumer group so a G2G outage retries only the
  // academic reaction, never the already-succeeded age gate. Together with the
  // criminal gate (background-vetting-service) a single submission autonomously
  // drives all three vetting dimensions the application-state projection needs to
  // reach the positive terminal. (In-memory bus has no cross-process delivery, so
  // this is only meaningful with real Kafka.)
  if (transport.kind === 'kafka') {
    await startApplicantSubmittedConsumer(bus, services.age);
    await startAcademicVettingConsumer(bus, { education: services.education, degree: services.degree });
    console.log(JSON.stringify({ msg: 'event_consumers_started', topic: 'applicant.submitted', gates: ['age', 'academic'] }));
  }

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: [
      ageEligibilityRoute(services.age, verify),
      educationCheckRoute(services.education, verify),
      degreeCheckRoute(services.degree, verify),
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
