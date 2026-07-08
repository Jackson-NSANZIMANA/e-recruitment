// ══════════════════════════════════════════════════════════════════
// rdf_ops schema — Rwanda Defence Force recruitment operations
// ISOLATED: Only accessible to usrp_rdf_officer and usrp_system_service
// ══════════════════════════════════════════════════════════════════

import {
  pgSchema,
  uuid,
  varchar,
  timestamp,
  integer,
  boolean,
  text,
  pgEnum,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { applicantIdentities } from './public-core.schema.js';

export const rdfOps = pgSchema('rdf_ops');

// ── Enums ─────────────────────────────────────────────────────────

export const rdfCategoryEnum = rdfOps.enum('application_category', [
  'GENERAL_ENLISTMENT',
  'RESERVE_FORCE_ALEVEL',
  'RESERVE_FORCE_UNIVERSITY',
  'RESERVE_FORCE_SPECIALIST',
]);

export const rdfApplicationStatusEnum = rdfOps.enum('application_status', [
  'DRAFT',
  'SUBMITTED',
  'ACADEMIC_VETTING',
  'CRIMINAL_CLEARANCE',
  'DOCUMENT_REVIEW_GREEN',
  'DOCUMENT_REVIEW_AMBER',
  'SLOT_ASSIGNED',
  'PHYSICAL_TEST_SCHEDULED',
  'PHYSICAL_TEST_COMPLETE',
  'MEDICAL_REVIEW',
  'FINAL_SHORTLIST',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
  'WALK_IN_REGISTERED',
  'WALK_IN_ON_SITE_VETTING',
  'WALK_IN_PHYSICAL_TEST',
  'WALK_IN_REJECTED',
]);

export const rdfAcademicStatusEnum = rdfOps.enum('academic_eligibility_status', [
  'PENDING', 'ELIGIBLE', 'INELIGIBLE',
]);

export const rdfAgeStatusEnum = rdfOps.enum('age_eligibility_status', [
  'PENDING', 'ELIGIBLE', 'INELIGIBLE',
]);

export const rdfCriminalStatusEnum = rdfOps.enum('criminal_clearance_status', [
  'PENDING', 'CLEARED', 'FLAGGED_CONVICTION', 'FLAGGED_DISMISSED', 'UNDER_REVIEW',
]);

export const rdfDocumentLaneEnum = rdfOps.enum('document_lane', [
  'GREEN', 'AMBER', 'RED',
]);

export const rdfDocumentTypeEnum = rdfOps.enum('document_type', [
  'NATIONAL_ID',
  'OLEVEL_CERTIFICATE',
  'ALEVEL_CERTIFICATE',
  'DEGREE_DIPLOMA_COPY',
  'GOOD_CONDUCT_CERTIFICATE',
  'NON_CONVICTION_CERTIFICATE',
]);

// ── rdf_ops.applications ──────────────────────────────────────────

export const rdfApplications = rdfOps.table(
  'applications',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Anonymous processing code — shown to officers instead of name
    // Format: RDF-XXXXX (zero-padded 5-digit sequence)
    processingCode: varchar('processing_code', { length: 20 }).notNull().unique(),

    // Link to shared identity (RLS prevents unauthorized joins)
    applicantId: uuid('applicant_id')
      .references(() => applicantIdentities.id)
      .notNull(),

    // Campaign this application belongs to
    campaignId: uuid('campaign_id').notNull(),

    // Application specifics
    category: rdfCategoryEnum('category').notNull(),
    status: rdfApplicationStatusEnum('status').notNull().default('DRAFT'),

    // ── Academic vetting ─────────────────────────────────────────
    // For S3/A-Level applicants: NESA index number
    nesaIndexNumber: varchar('nesa_index_number', { length: 20 }),
    nesaVerificationRequestId: varchar('nesa_verification_request_id', { length: 128 }),
    nesaVerifiedAt: timestamp('nesa_verified_at', { withTimezone: true }),

    // For University/IPRC applicants: HEC registration number
    hecRegistrationNumber: varchar('hec_registration_number', { length: 50 }),
    hecVerificationRequestId: varchar('hec_verification_request_id', { length: 128 }),
    hecVerifiedAt: timestamp('hec_verified_at', { withTimezone: true }),

    // Specialist field declared (for age exception calculation)
    // e.g. 'MEDICINE', 'ENGINEERING', 'LAW'
    declaredSpecialistField: varchar('declared_specialist_field', { length: 50 }),

    academicStatus: rdfAcademicStatusEnum('academic_status').notNull().default('PENDING'),
    // JSON: { eligible: bool, reason: string, details: {...} }
    academicEligibilityDetail: jsonb('academic_eligibility_detail'),

    // ── Age vetting (projected from the age gate; DOB-free detail) ──
    ageEligibilityStatus: rdfAgeStatusEnum('age_eligibility_status').notNull().default('PENDING'),
    ageVerifiedAt: timestamp('age_verified_at', { withTimezone: true }),
    // JSON: { eligible, ageAtEvaluation, appliedMaxAge, reason } — never the DOB
    ageEligibilityDetail: jsonb('age_eligibility_detail'),

    // ── Criminal vetting ─────────────────────────────────────────
    ribRequestId: varchar('rib_request_id', { length: 128 }),
    criminalClearanceStatus: rdfCriminalStatusEnum('criminal_clearance_status')
      .notNull()
      .default('PENDING'),
    criminalClearanceAt: timestamp('criminal_clearance_at', { withTimezone: true }),

    // ── Document forensics ────────────────────────────────────────
    documentLane: rdfDocumentLaneEnum('document_lane'),
    documentForensicsScore: integer('document_forensics_score'),
    // JSON: { elaAnomalyDetected: bool, fontMismatch: bool, ... }
    documentForensicsFlags: jsonb('document_forensics_flags'),
    // Officer who reviewed amber/red documents
    documentReviewedById: uuid('document_reviewed_by_id'),
    documentReviewedAt: timestamp('document_reviewed_at', { withTimezone: true }),
    documentReviewDecision: varchar('document_review_decision', { length: 10 }),
    documentReviewNotes: varchar('document_review_notes', { length: 500 }),

    // ── Physical test scheduling ──────────────────────────────────
    venueAssignmentId: uuid('venue_assignment_id'),
    physicalTestScheduledAt: timestamp('physical_test_scheduled_at', { withTimezone: true }),
    assignedDistrict: varchar('assigned_district', { length: 30 }),
    assignedVenueName: varchar('assigned_venue_name', { length: 200 }),

    // QR invitation code — unique per application, used by field officers
    qrInvitationCode: varchar('qr_invitation_code', { length: 64 }).unique(),
    qrInvitationIssuedAt: timestamp('qr_invitation_issued_at', { withTimezone: true }),

    // SMS notification tracking
    smsNotificationSentAt: timestamp('sms_notification_sent_at', { withTimezone: true }),
    smsNotificationStatus: varchar('sms_notification_status', { length: 20 }),

    // ── Physical test results ─────────────────────────────────────
    physicalTestCompletedAt: timestamp('physical_test_completed_at', { withTimezone: true }),
    physicalTestScoreId: uuid('physical_test_score_id'),
    isWalkIn: boolean('is_walk_in').notNull().default(false),

    // ── Medical review ────────────────────────────────────────────
    medicalReviewedById: uuid('medical_reviewed_by_id'),
    medicalReviewedAt: timestamp('medical_reviewed_at', { withTimezone: true }),
    medicalFitnessStatus: varchar('medical_fitness_status', { length: 20 }),

    // ── Final decision ────────────────────────────────────────────
    finalDecisionById: uuid('final_decision_by_id'),
    finalDecisionAt: timestamp('final_decision_at', { withTimezone: true }),
    finalDecisionNotes: varchar('final_decision_notes', { length: 1000 }),

    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_rdf_processing_code').on(t.processingCode),
    index('idx_rdf_applicant_id').on(t.applicantId),
    index('idx_rdf_campaign_id').on(t.campaignId),
    index('idx_rdf_status').on(t.status),
    index('idx_rdf_document_lane').on(t.documentLane),
    index('idx_rdf_academic_status').on(t.academicStatus),
    index('idx_rdf_age_status').on(t.ageEligibilityStatus),
    index('idx_rdf_criminal_status').on(t.criminalClearanceStatus),
    index('idx_rdf_district').on(t.assignedDistrict),
    uniqueIndex('idx_rdf_qr_code').on(t.qrInvitationCode),
  ],
);

// ── rdf_ops.application_status_history ───────────────────────────
// Immutable audit trail of every status transition
// No UPDATE or DELETE — INSERT ONLY

export const rdfApplicationStatusHistory = rdfOps.table(
  'application_status_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rdfApplications.id)
      .notNull(),
    fromStatus: rdfApplicationStatusEnum('from_status'),   // null for initial DRAFT
    toStatus: rdfApplicationStatusEnum('to_status').notNull(),
    reason: varchar('reason', { length: 200 }),
    performedBy: varchar('performed_by', { length: 50 }).notNull(), // 'SYSTEM' or officer UUID
    performedAt: timestamp('performed_at', { withTimezone: true }).defaultNow().notNull(),
    correlationId: varchar('correlation_id', { length: 128 }), // Kafka correlationId
  },
  (t) => [
    index('idx_rdf_status_hist_app').on(t.applicationId),
    index('idx_rdf_status_hist_time').on(t.performedAt),
  ],
);

// ── rdf_ops.document_records ──────────────────────────────────────
// One row per uploaded document per application
// Tracks the full forensics lifecycle of each document

export const rdfDocumentRecords = rdfOps.table(
  'document_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rdfApplications.id)
      .notNull(),
    documentType: rdfDocumentTypeEnum('document_type').notNull(),

    // MinIO object store reference
    minioObjectKey: varchar('minio_object_key', { length: 512 }),
    minioObjectBucket: varchar('minio_object_bucket', { length: 100 }),
    fileSizeBytes: integer('file_size_bytes'),
    mimeType: varchar('mime_type', { length: 50 }),

    // Virus scan
    virusScanStatus: varchar('virus_scan_status', { length: 20 }),
    virusScanAt: timestamp('virus_scan_at', { withTimezone: true }),

    // Forensics pipeline results
    forensicsScore: integer('forensics_score'),
    forensicsLane: rdfDocumentLaneEnum('forensics_lane'),
    forensicsFlags: jsonb('forensics_flags'),
    forensicsCompletedAt: timestamp('forensics_completed_at', { withTimezone: true }),

    // API verification (Green Lane — verified directly via NESA/HEC)
    verifiedViaApi: boolean('verified_via_api').default(false),
    apiVerificationToken: varchar('api_verification_token', { length: 128 }),
    apiVerifiedAt: timestamp('api_verified_at', { withTimezone: true }),

    // Human review (Amber Lane)
    humanReviewedById: uuid('human_reviewed_by_id'),
    humanReviewedAt: timestamp('human_reviewed_at', { withTimezone: true }),
    humanReviewDecision: varchar('human_review_decision', { length: 10 }),

    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_rdf_docs_application').on(t.applicationId),
    index('idx_rdf_docs_type').on(t.documentType),
    index('idx_rdf_docs_lane').on(t.forensicsLane),
  ],
);

// ── rdf_ops.physical_test_scores ──────────────────────────────────
// CRDT-synced scores from field tablets
// Device-signed — tampering detectable via deviceSignature

export const rdfPhysicalTestScores = rdfOps.table(
  'physical_test_scores',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rdfApplications.id)
      .notNull(),

    // CRDT vector clock for conflict detection
    // JSON: { "device-uuid-1": 3, "device-uuid-2": 1 }
    vectorClock: jsonb('vector_clock').notNull(),
    deviceId: varchar('device_id', { length: 64 }).notNull(),

    // Physical metrics — bounded at tablet input level
    heightCm: integer('height_cm'),         // 140–220
    weightKg: integer('weight_kg'),         // 40–150
    run3kmTimeSeconds: integer('run_3km_time_seconds'),
    chestCm: integer('chest_cm'),
    medicalFitnessStatus: varchar('medical_fitness_status', { length: 20 }),
    additionalNotes: varchar('additional_notes', { length: 500 }),

    // Integrity verification
    // Ed25519 signature of the metrics payload by the capturing device
    deviceSignature: varchar('device_signature', { length: 512 }).notNull(),
    signedPayloadHash: varchar('signed_payload_hash', { length: 64 }).notNull(),

    // Officer identity
    capturingOfficerId: uuid('capturing_officer_id').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),

    // Sync metadata
    syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow(),
    syncConflictDetected: boolean('sync_conflict_detected').default(false),
    syncConflictResolution: varchar('sync_conflict_resolution', { length: 50 }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_rdf_scores_application').on(t.applicationId),
    index('idx_rdf_scores_device').on(t.deviceId),
    index('idx_rdf_scores_captured').on(t.capturedAt),
  ],
);
