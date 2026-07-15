// ══════════════════════════════════════════════════════════════════
// document-forensics-service — Runtime entrypoint (composition + bootstrap)
//
// A DB-writing HTTP service that emits over the backbone: analyze a
// referenced document's real bytes → record the verdict → emit
// document.forensics + audit. Transport is env-selected: Kafka when
// KAFKA_BROKERS is set, else in-memory (dev only — the emitted verdict then
// reaches no routing projection, logged loudly). Ready = the database (the
// verdict's durable home) is reachable.
// ══════════════════════════════════════════════════════════════════

import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import { loadKafkaConfig } from '@usrp/shared-config';
import { makeAuthVerifier } from '@usrp/shared-auth';
import { startHttpServer } from '@usrp/shared-http';
import { sql } from '@usrp/shared-database';
import { createDocumentForensicsService } from './index.js';
import { loadDocumentForensicsConfig } from './config.js';
import { analyzeDocumentRoute } from './adapters/http/analyze-document.controller.js';

function createEventBus(serviceName: string): EventBus {
  if (process.env['KAFKA_BROKERS']) {
    const kafka = loadKafkaConfig(serviceName);
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail:
        'KAFKA_BROKERS unset — using in-memory event bus (document.forensics reaches no consumer). Dev/tier1 only.',
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  const config = loadDocumentForensicsConfig();
  const bus = createEventBus(config.runtime.serviceName);
  await bus.connect();

  const service = createDocumentForensicsService(config, bus);
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: [analyzeDocumentRoute(service.analyzeDocument, verify)],
    // Ready only when the verdict's durable home is reachable.
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
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'document-forensics-service' }), err);
  process.exit(1);
});
