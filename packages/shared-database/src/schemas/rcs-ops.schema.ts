// ══════════════════════════════════════════════════════════════════
// rcs_ops schema — Rwanda Correctional Service recruitment operations
// ISOLATED: Only accessible to usrp_rcs_officer and usrp_system_service
//
// Key differences from rdf_ops and rnp_ops:
// 1. Four categories including OFFICER_FOUR_YEAR_UR (university intake)
// 2. Celibacy certificate required for ALL RCS categories
// 3. Medical certificate from government physician required
// 4. Notarized documents required (not just photocopies)
// 5. "Under criminal prosecution" also disqualifies (not just conviction)
// 6. OFFICER_FOUR_YEAR_UR: age max 21, science grade >= 70%, UR program required
// ══════════════════════════════════════════════════════════════════

import {
  pgSchema,
  uuid,
  varchar,
  timestamp,
  integer,
  boolean,
  pgEnum,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { applicantIdentities } from './public-core.schema.js';

export const rcsOps = pgSchema('rcs_ops');

// ── Enums ─────────────────────────────────────────────────────────

export const rcsCategoryEnum = rcsOps.enum('application_category', [
  'GENERAL_ENLISTEE',
  'OFFICER_ONE_YEAR',
  'OFFICER_ONE_YEAR_SPECIALIST',
  'OFFICER_FOUR_YEAR_UR',
]);

export const rcsApplicationStatusEnum = rcsOps.enum('application_status', [
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
]);

export const rcsAcademicStatusEnum = rcsOps.enum('academic_eligibility_status', [
  'PENDING', 'ELIGIBLE', 'INELIGIBLE',
]);

// RCS has extended criminal clearance statuses
export const rcsCriminalStatusEnum = rcsOps.enum('criminal_clearance_status', [
  'PENDING',
  'CLEARED',
  'FLAGGED_CONVICTION',
  'FLAGGED_PROSECUTION',  // Under active criminal prosecution — RCS-specific disqualifier
  'FLAGGED_DISMISSED',
  'UNDER_REVIEW',
]);

export const rcsDocumentLaneEnum = rcsOps.enum('document_lane', [
  'GREEN', 'AMBER', 'RED',
]);

// RCS has the most extensive document list of all three agencies
export const rcsDocumentTypeEnum = rcsOps.enum('document_type', [
  'NATIONAL_ID',
  'APPLICATION_FORM_WITH_PHOTO',
  'BIRTH_CERTIFICATE',
  'ALEVEL_CERTIFICATE',
  'DEGREE_DIPLOMA_NOTARIZED',   // Notarized — not just photocopy
  'GOOD_CONDUCT_CERTIFICATE',
  'NON_CONVICTION_CERTIFICATE',
  'CELIBACY_CERTIFICATE',        // Unique to RCS — proves single marital status
  'MEDICAL_CERTIFICATE_GOVT',    // Must be from authorized government physician
]);

export const rcsUrProgramEnum = rcsOps.enum('ur_program', [
  'GENERAL_MEDICINE',
  'GENERAL_NURSING',
  'COMPUTER_ENGINEERING',
  'DENTAL_SURGERY',
]);

// ── rcs_ops.applications ──────────────────────────────────────────

export const rcsApplications = rcsOps.table(
  'applications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    processingCode: varchar('processing_code', { length: 20 }).notNull().unique(),
    applicantId: uuid('applicant_id')
      .references(() => applicantIdentities.id)
      .notNull(),
    campaignId: uuid('campaign_id').notNull(),
    category: rcsCategoryEnum('category').notNull(),
    status: rcsApplicationStatusEnum('status').notNull().default('DRAFT'),

    // ── Academic vetting ─────────────────────────────────────────
    nesaIndexNumber: varchar('nesa_index_number', { length: 20 }),
    nesaVerificationRequestId: varchar('nesa_verification_request_id', { length: 128 }),
    nesaVerifiedAt: timestamp('nesa_verified_at', { withTimezone: true }),
    hecRegistrationNumber: varchar('hec_registration_number', { length: 50 }),
    hecVerificationRequestId: varchar('hec_verification_request_id', { length: 128 }),
    hecVerifiedAt: timestamp('hec_verified_at', { withTimezone: true }),

    // RCS-specific: Specialist field for age exception
    declaredSpecialistField: varchar('declared_specialist_field', { length: 50 }),

    // OFFICER_FOUR_YEAR_UR specific fields
    // The UR program the applicant is applying to study
    urProgramApplied: rcsUrProgramEnum('ur_program_applied'),
    // Science percentage from NESA (must be >= 70%)
    nesaSciencePercentage: integer('nesa_science_percentage'),

    academicStatus: rcsAcademicStatusEnum('academic_status').notNull().default('PENDING'),
    academicEligibilityDetail: jsonb('academic_eligibility_detail'),

    // ── Criminal vetting ─────────────────────────────────────────
    ribRequestId: varchar('rib_request_id', { length: 128 }),
    criminalClearanceStatus: rcsCriminalStatusEnum('criminal_clearance_status')
      .notNull()
      .default('PENDING'),
    // RCS-specific: tracks whether active prosecution check was performed
    prosecutionCheckPerformed: boolean('prosecution_check_performed').default(false),
    prosecutionCheckAt: timestamp('prosecution_check_at', { withTimezone: true }),
    criminalClearanceAt: timestamp('criminal_clearance_at', { withTimezone: true }),

    // ── Document forensics ────────────────────────────────────────
    documentLane: rcsDocumentLaneEnum('document_lane'),
    documentForensicsScore: integer('document_forensics_score'),
    documentForensicsFlags: jsonb('document_forensics_flags'),
    documentReviewedById: uuid('document_reviewed_by_id'),
    documentReviewedAt: timestamp('document_reviewed_at', { withTimezone: true }),
    documentReviewDecision: varchar('document_review_decision', { length: 10 }),

    // ── RCS-Specific Document Verification Status ─────────────────
    // These are required for ALL RCS categories — tracked separately
    celibacyCertVerified: boolean('celibacy_cert_verified').default(false),
    celibacyCertVerifiedAt: timestamp('celibacy_cert_verified_at', { withTimezone: true }),
    medicalCertVerified: boolean('medical_cert_verified').default(false),
    medicalCertVerifiedAt: timestamp('medical_cert_verified_at', { withTimezone: true }),
    medicalCertPhysicianName: varchar('medical_cert_physician_name', { length: 200 }),
    // Birth certificate — required for Officer categories
    birthCertVerified: boolean('birth_cert_verified').default(false),
    birthCertVerifiedAt: timestamp('birth_cert_verified_at', { withTimezone: true }),

    // ── Scheduling ────────────────────────────────────────────────
    venueAssignmentId: uuid('venue_assignment_id'),
    physicalTestScheduledAt: timestamp('physical_test_scheduled_at', { withTimezone: true }),
    assignedDistrict: varchar('assigned_district', { length: 30 }),
    assignedVenueName: varchar('assigned_venue_name', { length: 200 }),

    qrInvitationCode: varchar('qr_invitation_code', { length: 64 }).unique(),
    qrInvitationIssuedAt: timestamp('qr_invitation_issued_at', { withTimezone: true }),
    smsNotificationSentAt: timestamp('sms_notification_sent_at', { withTimezone: true }),

    // ── Physical test results ─────────────────────────────────────
    physicalTestCompletedAt: timestamp('physical_test_completed_at', { withTimezone: true }),
    physicalTestScoreId: uuid('physical_test_score_id'),

    // ── Final decision ────────────────────────────────────────────
    finalDecisionById: uuid('final_decision_by_id'),
    finalDecisionAt: timestamp('final_decision_at', { withTimezone: true }),
    finalDecisionNotes: varchar('final_decision_notes', { length: 1000 }),

    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_rcs_processing_code').on(t.processingCode),
    index('idx_rcs_applicant_id').on(t.applicantId),
    index('idx_rcs_campaign_id').on(t.campaignId),
    index('idx_rcs_status').on(t.status),
    index('idx_rcs_document_lane').on(t.documentLane),
    index('idx_rcs_academic_status').on(t.academicStatus),
    index('idx_rcs_category').on(t.category),
    index('idx_rcs_criminal_status').on(t.criminalClearanceStatus),
    uniqueIndex('idx_rcs_qr_code').on(t.qrInvitationCode),
  ],
);

export const rcsApplicationStatusHistory = rcsOps.table(
  'application_status_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rcsApplications.id)
      .notNull(),
    fromStatus: rcsApplicationStatusEnum('from_status'),
    toStatus: rcsApplicationStatusEnum('to_status').notNull(),
    reason: varchar('reason', { length: 200 }),
    performedBy: varchar('performed_by', { length: 50 }).notNull(),
    performedAt: timestamp('performed_at', { withTimezone: true }).defaultNow().notNull(),
    correlationId: varchar('correlation_id', { length: 128 }),
  },
  (t) => [
    index('idx_rcs_status_hist_app').on(t.applicationId),
  ],
);

export const rcsDocumentRecords = rcsOps.table(
  'document_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rcsApplications.id)
      .notNull(),
    documentType: rcsDocumentTypeEnum('document_type').notNull(),
    // RCS requires notarized documents — track notarization status
    isNotarized: boolean('is_notarized').default(false),
    notarizationReference: varchar('notarization_reference', { length: 100 }),
    minioObjectKey: varchar('minio_object_key', { length: 512 }),
    minioObjectBucket: varchar('minio_object_bucket', { length: 100 }),
    fileSizeBytes: integer('file_size_bytes'),
    mimeType: varchar('mime_type', { length: 50 }),
    virusScanStatus: varchar('virus_scan_status', { length: 20 }),
    virusScanAt: timestamp('virus_scan_at', { withTimezone: true }),
    forensicsScore: integer('forensics_score'),
    forensicsLane: rcsDocumentLaneEnum('forensics_lane'),
    forensicsFlags: jsonb('forensics_flags'),
    forensicsCompletedAt: timestamp('forensics_completed_at', { withTimezone: true }),
    verifiedViaApi: boolean('verified_via_api').default(false),
    apiVerificationToken: varchar('api_verification_token', { length: 128 }),
    apiVerifiedAt: timestamp('api_verified_at', { withTimezone: true }),
    humanReviewedById: uuid('human_reviewed_by_id'),
    humanReviewedAt: timestamp('human_reviewed_at', { withTimezone: true }),
    humanReviewDecision: varchar('human_review_decision', { length: 10 }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_rcs_docs_application').on(t.applicationId),
    index('idx_rcs_docs_type').on(t.documentType),
  ],
);

export const rcsPhysicalTestScores = rcsOps.table(
  'physical_test_scores',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rcsApplications.id)
      .notNull(),
    vectorClock: jsonb('vector_clock').notNull(),
    deviceId: varchar('device_id', { length: 64 }).notNull(),
    heightCm: integer('height_cm'),
    weightKg: integer('weight_kg'),
    run3kmTimeSeconds: integer('run_3km_time_seconds'),
    chestCm: integer('chest_cm'),
    medicalFitnessStatus: varchar('medical_fitness_status', { length: 20 }),
    additionalNotes: varchar('additional_notes', { length: 500 }),
    deviceSignature: varchar('device_signature', { length: 512 }).notNull(),
    signedPayloadHash: varchar('signed_payload_hash', { length: 64 }).notNull(),
    capturingOfficerId: uuid('capturing_officer_id').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow(),
    syncConflictDetected: boolean('sync_conflict_detected').default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_rcs_scores_application').on(t.applicationId),
  ],
);
