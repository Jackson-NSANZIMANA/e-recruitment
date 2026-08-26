// ══════════════════════════════════════════════════════════════════
// biometric-service — Runtime entrypoint (composition + bootstrap)
//
// An officer-facing HTTP gate that emits over the backbone. It exposes
// POST /v1/biometric/verify (officer-authenticated) and publishes
// biometric.result. DB-free — identity-service records the outcome. Transport
// is resolved by @usrp/shared-config: Kafka when KAFKA_BROKERS is set, else an
// in-memory bus in DEVELOPMENT only (the emitted result then reaches no
// consumer, so a venue check-in is accepted and never recorded — logged loudly).
//
// BOOTSTRAP IS INSTRUMENTED, PHASE BY PHASE. This service is DB-free, so it
// has no readiness callback to fail through — either it reaches
// server.listen() or it is invisible. That made it the hardest service in the
// repo to diagnose from a boot log, which is precisely what happened. Each
// phase is now logged BEFORE it is attempted, so a hang or throw leaves its
// own name as the last line, and the blocking step is bounded rather than
// infinite.
// ══════════════════════════════════════════════════════════════════

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
import { makeAuthVerifier } from '@usrp/shared-auth';
import { startHttpServer } from '@usrp/shared-http';
import { createBiometricService } from './index.js';
import { loadBiometricConfig } from './config.js';
import { verifyBiometricRoute } from './adapters/http/verify-biometric.controller.js';

const SERVICE_NAME = 'biometric-service';

function createEventBus(serviceName: string, transport: EventTransport): EventBus {
  if (transport.kind === 'kafka') {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail: 'KAFKA_BROKERS unset — using in-memory event bus (biometric.result reaches no consumer). Dev/tier1 only.',
      reason: transport.reason,
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  // Phase names are written for whoever is reading a red job, and each is
  // emitted BEFORE the work it describes. A marker printed afterwards would
  // only ever confirm what already succeeded.
  logStartupPhase(SERVICE_NAME, 'asserting_production_secrets');
  assertProductionSecrets();

  // Not merely reading env: this decodes QR_INVITATION_PUBLIC_KEY_B64 and
  // runs createPublicKey() on it, so a malformed or truncated key fails HERE.
  logStartupPhase(SERVICE_NAME, 'loading_config');
  const config = loadBiometricConfig();

  logStartupPhase(SERVICE_NAME, 'resolving_event_transport');
  const transport = resolveEventTransport();

  const bus = createEventBus(config.runtime.serviceName, transport);

  // THE ONE STEP THAT CAN BLOCK INDEFINITELY. Bounded in the transport itself
  // (see @usrp/shared-events/startup.ts); bounded again here so the failure
  // message names this service's phase and not just 'the producer'.
  logStartupPhase(SERVICE_NAME, 'connecting_event_bus', { transport: transport.kind });
  await withStartupTimeout(bus.connect(), 'connecting the event bus');
  logStartupPhase(SERVICE_NAME, 'event_bus_connected', { transport: transport.kind });

  const service = createBiometricService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  // The port is logged with the bind attempt on purpose: the proof reports
  // failures as ':4003', and nobody should have to re-derive
  // PORT_BIOMETRIC_SERVICE by hand to connect the two.
  logStartupPhase(SERVICE_NAME, 'starting_http_server', { port: config.runtime.port });
  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: [verifyBiometricRoute(service.verifyBiometric, verify)],
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
      emitting: transport.kind === 'kafka' ? 'biometric.result' : 'none (in-memory bus)',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: SERVICE_NAME }), err);
  process.exit(1);
});
