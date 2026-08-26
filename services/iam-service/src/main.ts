// ══════════════════════════════════════════════════════════════════
// iam-service — Runtime entrypoint (composition + bootstrap)
//
// The token issuer: a small HTTP service whose one business route, officer
// login, mints Ed25519 bearer tokens the existing officer endpoints accept.
// It is the SOLE holder of the issuer private key; every other service only
// verifies with the public key.
//
// Transport is resolved by @usrp/shared-config: with KAFKA_BROKERS set it
// publishes the login AUDIT_ENTRY to real Kafka; without it, in DEVELOPMENT
// only, an in-memory bus keeps the process runnable on a tier1-only stack (the
// audit is then recorded by nobody — logged loudly). Login itself does not
// depend on the bus, which is precisely why this degradation is dangerous in
// production: every login succeeds and NOTHING records that it happened.
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
import { createIamService, loadIamConfig } from './index.js';
import { officerLoginRoutes } from './adapters/http/officer-login.controller.js';
import { serviceTokenRoutes } from './adapters/http/service-token.controller.js';

function createEventBus(serviceName: string, transport: EventTransport): EventBus {
  if (transport.kind === 'kafka') {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail:
        'KAFKA_BROKERS unset — using in-memory event bus. Login still works; the success AUDIT_ENTRY is recorded by nobody. Dev/tier1 only.',
      reason: transport.reason,
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  assertProductionSecrets();

  const config = loadIamConfig();
  const transport = resolveEventTransport();
  const bus = createEventBus(config.runtime.serviceName, transport);
  await bus.connect();

  const service = createIamService(config, bus);

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: [...officerLoginRoutes(service.login), ...serviceTokenRoutes(service.serviceToken)],
    // Ready only when the credential store — the login path's home — is reachable.
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
      auditing: transport.kind === 'kafka' ? 'audit.immutable' : 'none (in-memory bus)',
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'iam-service' }), err);
  process.exit(1);
});
