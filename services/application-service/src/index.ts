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
import { PgOfficerTransitionRepository } from './adapters/officer-transition.pg-repository.js';
import { PgWalkInRepository } from './adapters/walk-in.pg-repository.js';
import { SubmitApplicationService } from './application/submit-application.service.js';
import { ListApplicationsService } from './application/list-applications.service.js';
import { OfficerTransitionsService } from './application/officer-transitions.service.js';
import { WalkInService } from './application/walk-in.service.js';
import { ProjectVettingResultService } from './application/project-vetting-result.service.js';
import { ProjectSlotAssignmentService } from './application/project-slot-assignment.service.js';
import { ProjectNotificationDeliveryService } from './application/project-notification-delivery.service.js';
import { ProjectPhysicalTestCompleteService } from './application/project-physical-test-complete.service.js';
import { ProjectForensicsResultService } from './application/project-forensics-result.service.js';
import { ProjectApplicationAcceptedService } from './application/project-application-accepted.service.js';
import { PgWithdrawalRepository } from './adapters/withdrawal.pg-repository.js';
import type { ApplicationServiceConfig } from './config.js';

/** The application aggregate's adapters over one repository. */
export interface ApplicationService {
  /** HTTP front door — CREATE an application (POST /v1/applications). */
  readonly submit: SubmitApplicationService;
  /** HTTP officer read — LIST an agency's applications (GET /v1/applications). */
  readonly list: ListApplicationsService;
  /** HTTP officer writes — DRIVE the tail of the green lane (medical/final/accept). */
  readonly officerTransitions: OfficerTransitionsService;
  /** HTTP officer writes — REGISTER + on-site-vet exam-day walk-ins (RDF, ADR-012). */
  readonly walkIn: WalkInService;
  /** Event projector — ADVANCE an application from vetting verdicts. */
  readonly projector: ProjectVettingResultService;
  /** Event projector — STAMP the exam slot (DOCUMENT_REVIEW_GREEN → SLOT_ASSIGNED). */
  readonly slotProjector: ProjectSlotAssignmentService;
  /** Event projector — RECORD invitation delivery (SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED). */
  readonly notificationProjector: ProjectNotificationDeliveryService;
  /** Event projector — COMPLETE the physical test (PHYSICAL_TEST_SCHEDULED → PHYSICAL_TEST_COMPLETE). */
  readonly physicalTestProjector: ProjectPhysicalTestCompleteService;
  /** Event projector — ROUTE a document forensics lane (AMBER hold / RED reject-or-adjudicate). */
  readonly forensicsProjector: ProjectForensicsResultService;
  /** Event projector — AUTO-WITHDRAW the accepted citizen's other in-flight applications (ADR-017). */
  readonly withdrawalProjector: ProjectApplicationAcceptedService;
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
  const officerTransitionRepository = new PgOfficerTransitionRepository();

  return {
    submit: new SubmitApplicationService({
      identityReader,
      campaignReader,
      repository,
      eventBus,
    }),
    list: new ListApplicationsService({ reader: readRepository }),
    officerTransitions: new OfficerTransitionsService({
      repository: officerTransitionRepository,
      eventBus,
    }),
    walkIn: new WalkInService({
      identityReader,
      campaignReader,
      repository: new PgWalkInRepository(),
      eventBus,
    }),
    projector: new ProjectVettingResultService({ repository, eventBus }),
    slotProjector: new ProjectSlotAssignmentService({ repository, eventBus }),
    notificationProjector: new ProjectNotificationDeliveryService({ repository, eventBus }),
    physicalTestProjector: new ProjectPhysicalTestCompleteService({ repository, eventBus }),
    forensicsProjector: new ProjectForensicsResultService({ repository, eventBus }),
    withdrawalProjector: new ProjectApplicationAcceptedService({
      repository: new PgWithdrawalRepository(),
      eventBus,
    }),
  };
}

// ── Re-exports ────────────────────────────────────────────────────
export {
  SUBMIT_APPLICATION_PATH,
  submitApplicationRoute,
} from './adapters/http/submit-application.controller.js';
export {
  LIST_APPLICATIONS_PATH,
  AMBER_QUEUE_PATH,
  BY_APPLICANT_PATH,
  listApplicationsRoute,
  amberQueueRoute,
  byApplicantRoute,
} from './adapters/http/list-applications.controller.js';
export {
  MEDICAL_REVIEW_PATH,
  FINAL_DECISION_PATH,
  ACCEPT_PATH,
  ADJUDICATE_PATH,
  officerTransitionRoutes,
} from './adapters/http/officer-transitions.controller.js';
export {
  WALK_IN_REGISTER_PATH,
  WALK_IN_VET_PATH,
  walkInRoutes,
} from './adapters/http/walk-in.controller.js';
export { SubmitApplicationService } from './application/submit-application.service.js';
export { ListApplicationsService } from './application/list-applications.service.js';
export { OfficerTransitionsService } from './application/officer-transitions.service.js';
export { WalkInService } from './application/walk-in.service.js';
export type {
  RegisterWalkInCommand,
  RegisterWalkInOutcome,
  VetWalkInCommand,
  VetWalkInOutcome,
} from './application/walk-in.service.js';
export type {
  MedicalReviewCommand,
  FinalDecisionCommand,
  AcceptCommand,
  AdjudicateCommand,
  AdjudicateCommandOutcome,
  OfficerCommandOutcome,
  OfficerTransitionsDeps,
} from './application/officer-transitions.service.js';
export { PgOfficerTransitionRepository } from './adapters/officer-transition.pg-repository.js';
export type {
  OfficerTransitionRepository,
  OfficerTransitionOutcome,
  AcceptOutcome,
  AdjudicateOutcome,
  OfficerActor,
  MedicalReviewInput,
  FinalDecisionInput,
  AcceptInput,
  AdjudicateInput,
} from './ports/officer-transition-repository.js';
export type {
  ListApplicationsCommand,
  ListApplicationsDeps,
  ListApplicationsOutcome,
  AmberQueueOutcome,
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
export {
  APPLICATION_NOTIFICATION_PROJECTION_GROUP,
  startNotificationDeliveredConsumer,
} from './adapters/events/notification-delivered.consumer.js';
export { ProjectNotificationDeliveryService } from './application/project-notification-delivery.service.js';
export type {
  ProjectNotificationDeliveryCommand,
  ProjectNotificationDeliveryDeps,
} from './application/project-notification-delivery.service.js';
export {
  APPLICATION_PHYSICAL_TEST_PROJECTION_GROUP,
  startFieldScoreCapturedConsumer,
} from './adapters/events/field-score-captured.consumer.js';
export {
  APPLICATION_FORENSICS_PROJECTION_GROUP,
  startForensicsResultConsumer,
} from './adapters/events/forensics-result.consumer.js';
export { ProjectForensicsResultService } from './application/project-forensics-result.service.js';
export type {
  ProjectForensicsResultCommand,
  ProjectForensicsResultDeps,
} from './application/project-forensics-result.service.js';
export { ProjectPhysicalTestCompleteService } from './application/project-physical-test-complete.service.js';
export type {
  ProjectPhysicalTestCompleteCommand,
  ProjectPhysicalTestCompleteDeps,
} from './application/project-physical-test-complete.service.js';
export { ProjectSlotAssignmentService } from './application/project-slot-assignment.service.js';
export type {
  ProjectSlotAssignmentCommand,
  ProjectSlotAssignmentDeps,
} from './application/project-slot-assignment.service.js';
export { ProjectApplicationAcceptedService } from './application/project-application-accepted.service.js';
export type {
  ProjectApplicationAcceptedCommand,
  ProjectApplicationAcceptedDeps,
} from './application/project-application-accepted.service.js';
export {
  APPLICATION_WITHDRAWAL_PROJECTION_GROUP,
  startApplicationAcceptedConsumer,
} from './adapters/events/application-accepted.consumer.js';
export { PgWithdrawalRepository } from './adapters/withdrawal.pg-repository.js';
export type {
  WithdrawalRepository,
  WithdrawnApplication,
  WithdrawSiblingsInput,
} from './ports/withdrawal-repository.js';
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
  ApplicantApplicationSummary,
  AmberQueueEntry,
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
  NotificationDeliveryResult,
  ApplyNotificationOutcome,
  PhysicalTestCompleteResult,
  ApplyPhysicalTestOutcome,
  ForensicsRoutingResult,
  ApplyForensicsOutcome,
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
