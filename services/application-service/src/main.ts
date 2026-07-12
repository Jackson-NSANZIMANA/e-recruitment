// ══════════════════════════════════════════════════════════════════
// application-service — Runtime entrypoint (composition + bootstrap)
//
// THE FRONT DOOR + STATE OWNER process. It composes the application aggregate
// with a real event transport and exposes two adapters (ADR-005 / ADR-006):
//   • HTTP front door — POST /v1/applications files an application and
//     publishes APPLICANT_SUBMITTED.
//   • Event projector — consumes the vetting result topics (vetting.nesa/hec/
//     rib) and advances the application through its lifecycle.
// load config → build the bus → assemble the aggregate → (subscribe) → serve →
// shut down cleanly.
//
// Transport is chosen by environment: with KAFKA_BROKERS set we publish AND
// consume over Kafka (prod/tier2); without it we fall back to an in-memory bus
// so the service still runs on a tier1-only dev stack (events are then
// local-only — logged loudly so this is never mistaken for durable transport).
// The projection consumer is only meaningful with a real broker, so it is wired
// only when KAFKA_BROKERS is set.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import { loadKafkaConfig } from '@usrp/shared-config';
import { makeAuthVerifier } from '@usrp/shared-auth';
import { startHttpServer } from '@usrp/shared-http';
import { createApplicationService } from './index.js';
import { loadApplicationConfig } from './config.js';
import { submitApplicationRoute } from './adapters/http/submit-application.controller.js';
import { listApplicationsRoute } from './adapters/http/list-applications.controller.js';
import { officerTransitionRoutes } from './adapters/http/officer-transitions.controller.js';
import { startVettingResultConsumer } from './adapters/events/vetting-result.consumer.js';
import { startSlotAssignedConsumer } from './adapters/events/slot-assigned.consumer.js';
import { startNotificationDeliveredConsumer } from './adapters/events/notification-delivered.consumer.js';
import { startFieldScoreCapturedConsumer } from './adapters/events/field-score-captured.consumer.js';

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
  const config = loadApplicationConfig();
  const bus = createEventBus(config.runtime.serviceName);
  await bus.connect();

  const service = createApplicationService(config, bus);

  // Ingress auth: verify inbound bearer tokens with the issuer public key.
  const verify = makeAuthVerifier({
    publicKeyPem: config.auth.authPublicKeyPem,
    issuer: config.auth.jwtIssuer,
    audience: config.auth.jwtAudience,
  });

  // State-projection ingress: consume the vetting result topics and advance
  // applications. Subscribe BEFORE serving so a "ready" signal implies we are
  // consuming. Only meaningful with a real broker.
  if (process.env['KAFKA_BROKERS']) {
    await startVettingResultConsumer(bus, service.projector);
    await startSlotAssignedConsumer(bus, service.slotProjector);
    await startNotificationDeliveredConsumer(bus, service.notificationProjector);
    await startFieldScoreCapturedConsumer(bus, service.physicalTestProjector);
    console.log(
      JSON.stringify({
        msg: 'event_consumers_started',
        topics:
          'vetting.nesa,vetting.hec,vetting.rib,vetting.age,slot.assigned,notification.delivered,field.score.captured',
      }),
    );
  }

  const server = await startHttpServer({
    serviceName: config.runtime.serviceName,
    port: config.runtime.port,
    routes: [
      submitApplicationRoute(service.submit, verify), // system-token required
      listApplicationsRoute(service.list, verify), // officer-token required
      // officer-token writes: medical-review / final-decision / accept
      ...officerTransitionRoutes(service.officerTransitions, verify),
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
  console.error(JSON.stringify({ msg: 'startup_failed', service: 'application-service' }), err);
  process.exit(1);
});
