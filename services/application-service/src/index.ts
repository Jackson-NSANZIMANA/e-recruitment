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
import { PgApplicationReadRepository } from './adapters/application-read.pg-repository.js';
import { SubmitApplicationService } from './application/submit-application.service.js';
import { ListApplicationsService } from './application/list-applications.service.js';
import { ProjectVettingResultService } from './application/project-vetting-result.service.js';
import { ProjectSlotAssignmentService } from './application/project-slot-assignment.service.js';
import type { ApplicationServiceConfig } from './config.js';

/** The application aggregate's adapters over one repository. */
export interface ApplicationService {
  /** HTTP front door — CREATE an application (POST /v1/applications). */
  readonly submit: SubmitApplicationService;
  /** HTTP officer read — LIST an agency's applications (GET /v1/applications). */
  readonly list: ListApplicationsService;
  /** Event projector — ADVANCE an application from vetting verdicts. */
  readonly projector: ProjectVettingResultService;
  /** Event projector — STAMP the exam slot (DOCUMENT_REVIEW_GREEN → SLOT_ASSIGNED). */
  readonly slotProjector: ProjectSlotAssignmentService;
}

/**
 * Assemble the application aggregate from config + a chosen event transport.
 * Both use cases share ONE PgApplicationRepository — the single writer of the
 * applications table (front door INSERTs, projector UPDATEs). All adapters go
 * through postgres.js `sql` (shared-database), so config carries no handles;
 * only the event bus does.
 */
export function createApplicationService(
  _config: ApplicationServiceConfig,
  eventBus: EventBus,
): ApplicationService {
  const identityReader = new PgIdentityReader();
  const campaignReader = new PgCampaignReader();
  const repository = new PgApplicationRepository();
  const readRepository = new PgApplicationReadRepository();

  return {
    submit: new SubmitApplicationService({
      identityReader,
      campaignReader,
      repository,
      eventBus,
    }),
    list: new ListApplicationsService({ reader: readRepository }),
    projector: new ProjectVettingResultService({ repository, eventBus }),
    slotProjector: new ProjectSlotAssignmentService({ repository, eventBus }),
  };
}

// ── Re-exports ────────────────────────────────────────────────────
export {
  SUBMIT_APPLICATION_PATH,
  submitApplicationRoute,
} from './adapters/http/submit-application.controller.js';
export {
  LIST_APPLICATIONS_PATH,
  listApplicationsRoute,
} from './adapters/http/list-applications.controller.js';
export { SubmitApplicationService } from './application/submit-application.service.js';
export { ListApplicationsService } from './application/list-applications.service.js';
export type {
  ListApplicationsCommand,
  ListApplicationsDeps,
  ListApplicationsOutcome,
} from './application/list-applications.service.js';
export type {
  SubmitApplicationCommand,
  SubmitApplicationDeps,
  SubmitApplicationOutcome,
} from './application/submit-application.service.js';
export { ProjectVettingResultService } from './application/project-vetting-result.service.js';
export type {
  ProjectVettingResultCommand,
  ProjectVettingResultDeps,
} from './application/project-vetting-result.service.js';
export {
  APPLICATION_PROJECTION_GROUP,
  startVettingResultConsumer,
} from './adapters/events/vetting-result.consumer.js';
export {
  APPLICATION_SLOT_PROJECTION_GROUP,
  startSlotAssignedConsumer,
} from './adapters/events/slot-assigned.consumer.js';
export { ProjectSlotAssignmentService } from './application/project-slot-assignment.service.js';
export type {
  ProjectSlotAssignmentCommand,
  ProjectSlotAssignmentDeps,
} from './application/project-slot-assignment.service.js';
export { deriveApplicationStatus } from './domain/lifecycle.js';
export type { VettingEvidence } from './domain/lifecycle.js';
export { AGENCY_TARGET, schemaForAgency } from './domain/agency-schema.js';
export { PgIdentityReader } from './adapters/identity.pg-reader.js';
export { PgCampaignReader } from './adapters/campaign.pg-reader.js';
export { PgApplicationRepository } from './adapters/application.pg-repository.js';
export { PgApplicationReadRepository } from './adapters/application-read.pg-repository.js';
export type {
  ApplicationReadRepository,
  ApplicationSummary,
  ListByAgencyInput,
} from './ports/application-read-repository.js';
export { loadApplicationConfig } from './config.js';
export type { ApplicationServiceConfig } from './config.js';
export type { IdentityReader, ApplicantIdentitySummary } from './ports/identity-reader.js';
export type { CampaignReader, OpenCampaign } from './ports/campaign-reader.js';
export type {
  ApplicationRepository,
  CreateApplicationInput,
  CreateApplicationResult,
  VettingResult,
  AcademicVettingResult,
  CriminalVettingResult,
  ApplyVettingOutcome,
  SlotAssignmentResult,
  ApplySlotOutcome,
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
