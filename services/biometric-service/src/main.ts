// ══════════════════════════════════════════════════════════════════
// biometric-service — Runtime entrypoint (composition + bootstrap)
//
// An officer-facing HTTP gate that emits over the backbone. It exposes
// POST /v1/biometric/verify (officer-authenticated) and publishes
// biometric.result. DB-free — identity-service records the outcome. Transport
// is resolved by @usrp/shared-config: Kafka when KAFKA_BROKERS is set, else an
// in-memory bus in DEVELOPMENT only (the emitted result then reaches no
// consumer, so a venue check-in is accepted and never recorded — logged loudly).
// ══════════════════════════════════════════════════════════════════

import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
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
  assertProductionSecrets();

  const config = loadBiometricConfig();
  const transport = resolveEventTransport();
  const bus = createEventBus(config.runtime.serviceName, transport);
  await bus.connect();

  const service = createBiometricService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

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
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'biometric-service' }), err);
  process.exit(1);
});
