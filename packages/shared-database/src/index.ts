// ══════════════════════════════════════════════════════════════════
// @usrp/shared-database — Public API
//
// IMPORT RULES FOR SERVICES:
//
//   Agency services import ONLY their schema subpath:
//     import { rdfApplications } from '@usrp/shared-database/schemas/rdf-ops'
//
//   Services that need the db client + types import from root:
//     import { db, type RdfApplication } from '@usrp/shared-database'
//
//   Never import schema files directly by path — always use this
//   package's exports. This ensures schema isolation is enforced
//   at the module resolution level, not just by convention.
// ══════════════════════════════════════════════════════════════════

import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

// ── Database Client ───────────────────────────────────────────────
export { db, sql, asJsonb } from './client.js';
export type { Database, JsonbValue } from './client.js';

// ── Schema Objects (tables + enums) ──────────────────────────────
// Re-exported so services can do:
//   db.select().from(rdfApplications).where(...)
export * from './schemas/public-core.schema.js';
export * from './schemas/rdf-ops.schema.js';
export * from './schemas/rnp-ops.schema.js';
export * from './schemas/rcs-ops.schema.js';
export * from './schemas/audit-log.schema.js';

// ══════════════════════════════════════════════════════════════════
// INFERRED ROW TYPES
// These are the TypeScript types services use for:
//   - Repository return values
//   - NestJS DTO base types
//   - Kafka event payload shapes
//   - Service interface contracts
//
// Select = what you get back from a SELECT query
// New    = what you pass into an INSERT (optional fields have ?:)
// ══════════════════════════════════════════════════════════════════

import {
  applicantIdentities,
  applicantSessions,
  recruitmentCampaigns,
  campaignVenueAssignments,
} from './schemas/public-core.schema.js';

import {
  rdfApplications,
  rdfApplicationStatusHistory,
  rdfDocumentRecords,
  rdfPhysicalTestScores,
} from './schemas/rdf-ops.schema.js';

import {
  rnpApplications,
  rnpApplicationStatusHistory,
  rnpDocumentRecords,
  rnpPhysicalTestScores,
} from './schemas/rnp-ops.schema.js';

import {
  rcsApplications,
  rcsApplicationStatusHistory,
  rcsDocumentRecords,
  rcsPhysicalTestScores,
} from './schemas/rcs-ops.schema.js';

import { auditEntries } from './schemas/audit-log.schema.js';

// ── public_core types ─────────────────────────────────────────────
export type ApplicantIdentity    = InferSelectModel<typeof applicantIdentities>;
export type NewApplicantIdentity = InferInsertModel<typeof applicantIdentities>;

export type ApplicantSession     = InferSelectModel<typeof applicantSessions>;
export type NewApplicantSession  = InferInsertModel<typeof applicantSessions>;

export type RecruitmentCampaign    = InferSelectModel<typeof recruitmentCampaigns>;
export type NewRecruitmentCampaign = InferInsertModel<typeof recruitmentCampaigns>;

export type CampaignVenueAssignment    = InferSelectModel<typeof campaignVenueAssignments>;
export type NewCampaignVenueAssignment = InferInsertModel<typeof campaignVenueAssignments>;

// ── rdf_ops types ─────────────────────────────────────────────────
export type RdfApplication    = InferSelectModel<typeof rdfApplications>;
export type NewRdfApplication = InferInsertModel<typeof rdfApplications>;

export type RdfApplicationStatusHistory    = InferSelectModel<typeof rdfApplicationStatusHistory>;
export type NewRdfApplicationStatusHistory = InferInsertModel<typeof rdfApplicationStatusHistory>;

export type RdfDocumentRecord    = InferSelectModel<typeof rdfDocumentRecords>;
export type NewRdfDocumentRecord = InferInsertModel<typeof rdfDocumentRecords>;

export type RdfPhysicalTestScore    = InferSelectModel<typeof rdfPhysicalTestScores>;
export type NewRdfPhysicalTestScore = InferInsertModel<typeof rdfPhysicalTestScores>;

// ── rnp_ops types ─────────────────────────────────────────────────
export type RnpApplication    = InferSelectModel<typeof rnpApplications>;
export type NewRnpApplication = InferInsertModel<typeof rnpApplications>;

export type RnpApplicationStatusHistory    = InferSelectModel<typeof rnpApplicationStatusHistory>;
export type NewRnpApplicationStatusHistory = InferInsertModel<typeof rnpApplicationStatusHistory>;

export type RnpDocumentRecord    = InferSelectModel<typeof rnpDocumentRecords>;
export type NewRnpDocumentRecord = InferInsertModel<typeof rnpDocumentRecords>;

export type RnpPhysicalTestScore    = InferSelectModel<typeof rnpPhysicalTestScores>;
export type NewRnpPhysicalTestScore = InferInsertModel<typeof rnpPhysicalTestScores>;

// ── rcs_ops types ─────────────────────────────────────────────────
export type RcsApplication    = InferSelectModel<typeof rcsApplications>;
export type NewRcsApplication = InferInsertModel<typeof rcsApplications>;

export type RcsApplicationStatusHistory    = InferSelectModel<typeof rcsApplicationStatusHistory>;
export type NewRcsApplicationStatusHistory = InferInsertModel<typeof rcsApplicationStatusHistory>;

export type RcsDocumentRecord    = InferSelectModel<typeof rcsDocumentRecords>;
export type NewRcsDocumentRecord = InferInsertModel<typeof rcsDocumentRecords>;

export type RcsPhysicalTestScore    = InferSelectModel<typeof rcsPhysicalTestScores>;
export type NewRcsPhysicalTestScore = InferInsertModel<typeof rcsPhysicalTestScores>;

// ── audit_log types ───────────────────────────────────────────────
export type AuditEntry    = InferSelectModel<typeof auditEntries>;
export type NewAuditEntry = InferInsertModel<typeof auditEntries>;

// ══════════════════════════════════════════════════════════════════
// ENUM VALUE TYPES
// Extracts the literal union from each drizzle enum so services
// can do type-safe comparisons without importing drizzle-orm:
//
//   function isAccepted(status: RdfApplicationStatusValue): boolean {
//     return status === 'ACCEPTED';
//   }
// ══════════════════════════════════════════════════════════════════

import {
  applicationChannelEnum,
  identityVerificationStatusEnum,
  genderEnum,
  campaignStatusEnum,
  agencyEnum,
} from './schemas/public-core.schema.js';

import {
  rdfCategoryEnum,
  rdfApplicationStatusEnum,
  rdfAcademicStatusEnum,
  rdfCriminalStatusEnum,
  rdfDocumentLaneEnum,
  rdfDocumentTypeEnum,
} from './schemas/rdf-ops.schema.js';

import {
  rnpCategoryEnum,
  rnpApplicationStatusEnum,
  rnpAcademicStatusEnum,
  rnpCriminalStatusEnum,
  rnpDocumentLaneEnum,
  rnpDocumentTypeEnum,
} from './schemas/rnp-ops.schema.js';

import {
  rcsCategoryEnum,
  rcsApplicationStatusEnum,
  rcsAcademicStatusEnum,
  rcsCriminalStatusEnum,
  rcsDocumentLaneEnum,
  rcsDocumentTypeEnum,
  rcsUrProgramEnum,
} from './schemas/rcs-ops.schema.js';

import {
  auditEntityTypeEnum,
  auditAgencyEnum,
} from './schemas/audit-log.schema.js';

// public_core enum value types
export type ApplicationChannel           = typeof applicationChannelEnum.enumValues[number];
export type IdentityVerificationStatus   = typeof identityVerificationStatusEnum.enumValues[number];
export type Gender                       = typeof genderEnum.enumValues[number];
export type CampaignStatus               = typeof campaignStatusEnum.enumValues[number];
export type Agency                       = typeof agencyEnum.enumValues[number];

// rdf_ops enum value types
export type RdfApplicationCategory      = typeof rdfCategoryEnum.enumValues[number];
export type RdfApplicationStatusValue   = typeof rdfApplicationStatusEnum.enumValues[number];
export type RdfAcademicStatus           = typeof rdfAcademicStatusEnum.enumValues[number];
export type RdfCriminalClearanceStatus  = typeof rdfCriminalStatusEnum.enumValues[number];
export type RdfDocumentLane             = typeof rdfDocumentLaneEnum.enumValues[number];
export type RdfDocumentType             = typeof rdfDocumentTypeEnum.enumValues[number];

// rnp_ops enum value types
export type RnpApplicationCategory      = typeof rnpCategoryEnum.enumValues[number];
export type RnpApplicationStatusValue   = typeof rnpApplicationStatusEnum.enumValues[number];
export type RnpAcademicStatus           = typeof rnpAcademicStatusEnum.enumValues[number];
export type RnpCriminalClearanceStatus  = typeof rnpCriminalStatusEnum.enumValues[number];
export type RnpDocumentLane             = typeof rnpDocumentLaneEnum.enumValues[number];
export type RnpDocumentType             = typeof rnpDocumentTypeEnum.enumValues[number];

// rcs_ops enum value types
export type RcsApplicationCategory      = typeof rcsCategoryEnum.enumValues[number];
export type RcsApplicationStatusValue   = typeof rcsApplicationStatusEnum.enumValues[number];
export type RcsAcademicStatus           = typeof rcsAcademicStatusEnum.enumValues[number];
export type RcsCriminalClearanceStatus  = typeof rcsCriminalStatusEnum.enumValues[number];
export type RcsDocumentLane             = typeof rcsDocumentLaneEnum.enumValues[number];
export type RcsDocumentType             = typeof rcsDocumentTypeEnum.enumValues[number];
export type RcsUrProgram                = typeof rcsUrProgramEnum.enumValues[number];

// audit_log enum value types
export type AuditEntityType             = typeof auditEntityTypeEnum.enumValues[number];
export type AuditAgency                 = typeof auditAgencyEnum.enumValues[number];
