// ══════════════════════════════════════════════════════════════════
// @usrp/application-service — Public API & composition root
//
// Wires the hexagonal core (the SubmitApplicationService use case) to its
// PostgreSQL adapters. The caller supplies the EventBus so tests can inject
// InMemoryEventBus and production can inject KafkaEventBus — the use case
// never knows which. Transport (HTTP) is composed in main.ts, not here.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { PgIdentityReader } from './adapters/identity.pg-reader.js';
import { PgCampaignReader } from './adapters/campaign.pg-reader.js';
import { PgApplicationRepository } from './adapters/application.pg-repository.js';
import { SubmitApplicationService } from './application/submit-application.service.js';
import type { ApplicationServiceConfig } from './config.js';

/**
 * Assemble the submit-application use case from config + a chosen event
 * transport. The front door reads identities + campaigns and writes into
 * the agency ops schemas — all through postgres.js `sql` (shared-database),
 * so config carries no adapter handles, only the event bus does.
 */
export function createApplicationService(
  _config: ApplicationServiceConfig,
  eventBus: EventBus,
): SubmitApplicationService {
  const identityReader = new PgIdentityReader();
  const campaignReader = new PgCampaignReader();
  const repository = new PgApplicationRepository();

  return new SubmitApplicationService({
    identityReader,
    campaignReader,
    repository,
    eventBus,
  });
}

// ── Re-exports ────────────────────────────────────────────────────
export {
  SUBMIT_APPLICATION_PATH,
  submitApplicationRoute,
} from './adapters/http/submit-application.controller.js';
export { SubmitApplicationService } from './application/submit-application.service.js';
export type {
  SubmitApplicationCommand,
  SubmitApplicationDeps,
  SubmitApplicationOutcome,
} from './application/submit-application.service.js';
export { PgIdentityReader } from './adapters/identity.pg-reader.js';
export { PgCampaignReader } from './adapters/campaign.pg-reader.js';
export { PgApplicationRepository } from './adapters/application.pg-repository.js';
export { loadApplicationConfig } from './config.js';
export type { ApplicationServiceConfig } from './config.js';
export type { IdentityReader, ApplicantIdentitySummary } from './ports/identity-reader.js';
export type { CampaignReader, OpenCampaign } from './ports/campaign-reader.js';
export type {
  ApplicationRepository,
  CreateApplicationInput,
  CreateApplicationResult,
} from './ports/application-repository.js';
export {
  academicPathForCategory,
  resolveAcademicInputs,
} from './domain/academic-input.js';
export type { AcademicPath, AcademicInputResult, ResolvedAcademicInputs } from './domain/academic-input.js';
export {
  ApplicationReadError,
  ApplicationPersistenceError,
} from './domain/application.errors.js';
