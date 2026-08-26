// ══════════════════════════════════════════════════════════════════
// identity-service — Runtime entrypoint (composition + bootstrap)
//
// The first RUNNABLE USRP process. It composes the hexagonal core with a
// real event transport and exposes it over HTTP (ADR-005): load config →
// build the event bus → assemble the use case → serve → shut down cleanly.
//
// Transport is resolved by @usrp/shared-config: with KAFKA_BROKERS set we
// publish to Kafka (prod/tier2); without it, in DEVELOPMENT only, we fall back
// to an in-memory bus so the service still runs on a tier1-only dev stack
// (events are then local-only — logged loudly so this is never mistaken for
// durable publishing).
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
import {
  createIdentityService,
  createBiometricResultProjector,
  createEraseIdentityService,
  createApplicantAuthService,
  createErasureRequestService,
} from './index.js';
import { loadApplicantPortalConfig, loadIdentityConfig } from './config.js';
import { verifyIdentityRoute } from './adapters/http/verify-identity.controller.js';
import { erasureRoute } from './adapters/http/erasure.controller.js';
import { applicantAuthRoutes } from './adapters/http/applicant-auth.controller.js';
import { erasureRequestRoutes } from './adapters/http/erasure-request.controller.js';
import { LogSmsChannel } from '@usrp/shared-sms';
import { HttpApplicationsGateway } from './adapters/applications.http-gateway.js';
import { startBiometricResultConsumer } from './adapters/events/biometric-result.consumer.js';

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

  const config = loadIdentityConfig();
  const transport = resolveEventTransport();
  const bus = createEventBus(config.runtime.serviceName, transport);
  await bus.connect();

  const service = createIdentityService(config, bus);

  // Record biometric outcomes onto applicant_identities off the backbone.
  // Subscribe BEFORE serving so a "ready" signal implies we are consuming.
  // Only meaningful with a real broker.
  if (transport.kind === 'kafka') {
    await startBiometricResultConsumer(bus, createBiometricResultProjector(config, bus));
    console.log(JSON.stringify({ msg: 'event_consumers_started', topics: 'biometric.result' }));
  }

  // Ingress auth: verify inbound bearer tokens with the issuer public key.
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  // Applicant auth (ADR-018): OTP → opaque session → self-service reads.
  // The portal config (iam/app-service endpoints + this service's client
  // credentials) and the dev SMS channel; production swaps a real telecom
  // adapter behind the same port.
  const portal = loadApplicantPortalConfig();
  // ONE channel instance serves OTP delivery AND the erasure decision
  // notices (ADR-022) — the real telecom adapter lands exactly once.
  const smsChannel = new LogSmsChannel();
  const applicantAuth = createApplicantAuthService(config, bus, smsChannel);
  const applicationsGateway = new HttpApplicationsGateway({
    iamBaseUrl: portal.iamBaseUrl,
    applicationBaseUrl: portal.applicationBaseUrl,
    clientId: portal.clientId,
    clientSecret: portal.clientSecret,
  });

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: [
      verifyIdentityRoute(service, verify),
      erasureRoute(createEraseIdentityService(config, bus, smsChannel), verify),
      ...applicantAuthRoutes(applicantAuth, applicationsGateway),
      // ADR-020: citizen erasure-request intake + officer/DPO queue routes
      ...erasureRequestRoutes(createErasureRequestService(config, bus, smsChannel), applicantAuth, verify),
    ],
    // Ready only when the database — the system-of-record — is reachable.
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
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'identity-service' }), err);
  process.exit(1);
});
