// ══════════════════════════════════════════════════════════════════
// rnp_ops schema — Rwanda National Police recruitment operations
// ISOLATED: Only accessible to usrp_rnp_officer and usrp_system_service
//
// Key differences from rdf_ops:
// 1. Two categories: CADET_OFFICER and BASIC_POLICE_COURSE
// 2. Criminal threshold: imprisonment > 6 months (Cadet) or >= 6 months (Basic)
//    → stored as applied_criminal_threshold column
// 3. No walk-in policy (RNP requires pre-registration at DPU)
// 4. No specialist field age exception for Basic Police Course
// ══════════════════════════════════════════════════════════════════

import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  varchar,
  char,
  timestamp,
  text,
  date,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { applicantIdentities, campaignPolicyVersions } from './public-core.schema.js';

export const rnpOps = pgSchema('rnp_ops');

// ── Enums ─────────────────────────────────────────────────────────

export const rnpCategoryEnum = rnpOps.enum('application_category', [
  'CADET_OFFICER',
  'BASIC_POLICE_COURSE',
]);

export const rnpApplicationStatusEnum = rnpOps.enum('application_status', [
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
  'ADJUDICATION_REVIEW',
  'REJECTED',
  'WITHDRAWN',
]);

export const rnpAcademicStatusEnum = rnpOps.enum('academic_eligibility_status', [
  'PENDING', 'ELIGIBLE', 'INELIGIBLE',
]);

export const rnpAgeStatusEnum = rnpOps.enum('age_eligibility_status', [
  'PENDING', 'ELIGIBLE', 'INELIGIBLE',
]);

export const rnpCriminalStatusEnum = rnpOps.enum('criminal_clearance_status', [
  'PENDING', 'CLEARED', 'FLAGGED_CONVICTION', 'FLAGGED_DISMISSED', 'UNDER_REVIEW',
]);

export const rnpDocumentLaneEnum = rnpOps.enum('document_lane', [
  'GREEN', 'AMBER', 'RED',
]);

export const rnpDocumentTypeEnum = rnpOps.enum('document_type', [
  'NATIONAL_ID',
  'APPLICATION_FORM_WITH_PHOTO',
  'ALEVEL_CERTIFICATE',
  'DEGREE_DIPLOMA_COPY',
  'GOOD_CONDUCT_CERTIFICATE',
]);

// ── rnp_ops.applications ──────────────────────────────────────────
// NOT MODELLED HERE (deliberate, ADR-027): the live-intent partial unique
// index applied by rls/0022_submission_integrity.sql —
//   uq_rnp_applications_live_intent
//     ON rnp_ops.applications (applicant_id, campaign_id, category)
//     WHERE status <> 'WITHDRAWN'
// It is the engine's guarantee that one citizen holds at most ONE live
// application per campaign+category. It is omitted from the mirror for the
// same reason CHECK constraints are (see docs/architecture/schema-evolution.md):
// verify-schema-drift.ts compares only `idx_*`-named indexes, so adding a
// `uq_`-named one to the snapshot would make the drift gate red forever.
// Its existence, uniqueness and exact predicate are asserted against the LIVE
// database instead, by
// services/application-service/selfcheck/verify-submission-integrity.ts §2.

export const rnpApplications = rnpOps.table(
  'applications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    processingCode: varchar('processing_code', { length: 20 }).notNull().unique(),
    applicantId: uuid('applicant_id')
      .references(() => applicantIdentities.id)
      .notNull(),
    campaignId: uuid('campaign_id').notNull(),
    category: rnpCategoryEnum('category').notNull(),
    status: rnpApplicationStatusEnum('status').notNull().default('DRAFT'),

    // ── Academic vetting ─────────────────────────────────────────
    nesaIndexNumber: varchar('nesa_index_number', { length: 20 }),
    nesaVerificationRequestId: varchar('nesa_verification_request_id', { length: 128 }),
    nesaVerifiedAt: timestamp('nesa_verified_at', { withTimezone: true }),
    hecRegistrationNumber: varchar('hec_registration_number', { length: 50 }),
    hecVerificationRequestId: varchar('hec_verification_request_id', { length: 128 }),
    hecVerifiedAt: timestamp('hec_verified_at', { withTimezone: true }),

    // Priority field declared (for officer ranking — not age exception)
    // e.g. 'STATISTICS', 'MEDICINE', 'ENGINEERING'
    declaredPriorityField: varchar('declared_priority_field', { length: 50 }),

    academicStatus: rnpAcademicStatusEnum('academic_status').notNull().default('PENDING'),
    academicEligibilityDetail: jsonb('academic_eligibility_detail'),

    // ── Age vetting (projected from the age gate; DOB-free detail) ──
    ageEligibilityStatus: rnpAgeStatusEnum('age_eligibility_status').notNull().default('PENDING'),
    ageVerifiedAt: timestamp('age_verified_at', { withTimezone: true }),
    ageEligibilityDetail: jsonb('age_eligibility_detail'),

    // ── Criminal vetting ─────────────────────────────────────────
    ribRequestId: varchar('rib_request_id', { length: 128 }),
    criminalClearanceStatus: rnpCriminalStatusEnum('criminal_clearance_status')
      .notNull()
      .default('PENDING'),
    // CRITICAL: Store which threshold was applied for audit
    // CADET_OFFICER = 'IMPRISONMENT_GT_6MO' | BASIC_POLICE_COURSE = 'IMPRISONMENT_GTE_6MO'
    appliedCriminalThreshold: varchar('applied_criminal_threshold', { length: 30 }),
    criminalClearanceAt: timestamp('criminal_clearance_at', { withTimezone: true }),

    // ── Document forensics ────────────────────────────────────────
    documentLane: rnpDocumentLaneEnum('document_lane'),
    documentForensicsScore: integer('document_forensics_score'),
    documentForensicsFlags: jsonb('document_forensics_flags'),
    documentReviewedById: uuid('document_reviewed_by_id'),
    documentReviewedAt: timestamp('document_reviewed_at', { withTimezone: true }),
    documentReviewDecision: varchar('document_review_decision', { length: 10 }),

    // ── Medical certificate (rls/0012, ADR-013) ───────────────────
    // RNP uses the government-physician CERTIFICATE model, mirroring
    // rcs_ops exactly (announcement: "Medical certificate approved by a
    // recognized government doctor"). RDF alone runs an in-house board
    // (medical_reviewed_* — rdf_ops only).
    medicalCertVerified: boolean('medical_cert_verified').default(false),
    medicalCertVerifiedAt: timestamp('medical_cert_verified_at', { withTimezone: true }),
    medicalCertPhysicianName: varchar('medical_cert_physician_name', { length: 200 }),

    // ── Scheduling ────────────────────────────────────────────────
    // RNP: Registration at DPU of residence — venue assigned by district
    registrationDpuDistrict: varchar('registration_dpu_district', { length: 30 }),
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
    // BUILD-002 (rls/0029): the policy version and calendar date that governed
    // this application. Write-once (trigger); consumers read these, not "now".
    policyVersionId: uuid('policy_version_id').references(() => campaignPolicyVersions.id),
    evaluationDate: date('evaluation_date'),
    // rls/0031 (ADR-033): the signed exam invitation (USRP-SLOT.v1…) the citizen
    // downloads as a QR. Write-once (trigger); shape CHECK not modelled here.
    qrSignedToken: text('qr_signed_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_rnp_processing_code').on(t.processingCode),
    index('idx_rnp_applicant_id').on(t.applicantId),
    index('idx_rnp_campaign_id').on(t.campaignId),
    index('idx_rnp_status').on(t.status),
    // rls/0035 (ADR-039): keyset order of the officer application search, and the venue roster.
    index('idx_rnp_applications_read_keyset').on(sql`(COALESCE(submitted_at, created_at)) DESC`, t.id.desc()),
    index('idx_rnp_applications_roster')
      .on(t.campaignId, t.assignedDistrict)
      .where(sql`assigned_district IS NOT NULL`),
    index('idx_rnp_document_lane').on(t.documentLane),
    index('idx_rnp_academic_status').on(t.academicStatus),
    index('idx_rnp_age_status').on(t.ageEligibilityStatus),
    index('idx_rnp_category').on(t.category),
    uniqueIndex('idx_rnp_qr_code').on(t.qrInvitationCode),
  ],
);

export const rnpApplicationStatusHistory = rnpOps.table(
  'application_status_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rnpApplications.id)
      .notNull(),
    fromStatus: rnpApplicationStatusEnum('from_status'),
    toStatus: rnpApplicationStatusEnum('to_status').notNull(),
    reason: varchar('reason', { length: 200 }),
    performedBy: varchar('performed_by', { length: 50 }).notNull(),
    performedAt: timestamp('performed_at', { withTimezone: true }).defaultNow().notNull(),
    correlationId: varchar('correlation_id', { length: 128 }),
  },
  (t) => [
    index('idx_rnp_status_hist_app').on(t.applicationId),
    index('idx_rnp_status_hist_time').on(t.performedAt),
  ],
);

export const rnpDocumentRecords = rnpOps.table(
  'document_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rnpApplications.id)
      .notNull(),
    documentType: rnpDocumentTypeEnum('document_type').notNull(),
    minioObjectKey: varchar('minio_object_key', { length: 512 }),
    minioObjectBucket: varchar('minio_object_bucket', { length: 100 }),
    fileSizeBytes: integer('file_size_bytes'),
    mimeType: varchar('mime_type', { length: 50 }),
    virusScanStatus: varchar('virus_scan_status', { length: 20 }),
    virusScanAt: timestamp('virus_scan_at', { withTimezone: true }),
    forensicsScore: integer('forensics_score'),
    forensicsLane: rnpDocumentLaneEnum('forensics_lane'),
    forensicsFlags: jsonb('forensics_flags'),
    forensicsCompletedAt: timestamp('forensics_completed_at', { withTimezone: true }),
    verifiedViaApi: boolean('verified_via_api').default(false),
    apiVerificationToken: varchar('api_verification_token', { length: 128 }),
    apiVerifiedAt: timestamp('api_verified_at', { withTimezone: true }),
    humanReviewedById: uuid('human_reviewed_by_id'),
    humanReviewedAt: timestamp('human_reviewed_at', { withTimezone: true }),
    humanReviewDecision: varchar('human_review_decision', { length: 10 }),

    // Venue verification (rls/0030, ADR-032): the check-in officer saw the
    // paper. Write-once. At most one per (application, type) — enforced by the
    // partial unique index uq_rnp_docs_venue_once, asserted live, not mirrored.
    venueVerifiedById: uuid('venue_verified_by_id'),
    venueVerifiedAt: timestamp('venue_verified_at', { withTimezone: true }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_rnp_docs_application').on(t.applicationId),
    index('idx_rnp_docs_type').on(t.documentType),
  ],
);

export const rnpPhysicalTestScores = rnpOps.table(
  'physical_test_scores',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rnpApplications.id)
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
    index('idx_rnp_scores_application').on(t.applicationId),
  ],
);

// ── Gate admission (rls/0032, BUILD-003, ADR-034) ─────────────────
// One immutable row per admitted application; single use is the pair of
// unique indexes. Append-only by trigger (not modelled here), as is the
// attempts log, which records every scan, refused or not, PII-free.

export const rnpGateAdmissions = rnpOps.table(
  'gate_admissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rnpApplications.id)
      .notNull(),
    ticketId: varchar('ticket_id', { length: 64 }).notNull(),
    campaignId: uuid('campaign_id').notNull(),
    venueName: varchar('venue_name', { length: 200 }).notNull(),
    examDate: date('exam_date').notNull(),
    identityMethod: varchar('identity_method', { length: 32 }).notNull(),
    admittedById: uuid('admitted_by_id').notNull(),
    admittedAt: timestamp('admitted_at', { withTimezone: true }).defaultNow().notNull(),
    correlationId: varchar('correlation_id', { length: 128 }),
  },
  (t) => [
    uniqueIndex('idx_rnp_gate_admissions_application').on(t.applicationId),
    uniqueIndex('idx_rnp_gate_admissions_ticket').on(t.ticketId),
  ],
);

export const rnpGateAdmissionAttempts = rnpOps.table(
  'gate_admission_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id'),
    ticketId: varchar('ticket_id', { length: 64 }),
    outcome: varchar('outcome', { length: 32 }).notNull(),
    gateVenueName: varchar('gate_venue_name', { length: 200 }).notNull(),
    officerId: uuid('officer_id').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).defaultNow().notNull(),
    correlationId: varchar('correlation_id', { length: 128 }),
  },
  (t) => [
    index('idx_rnp_gate_attempts_application').on(t.applicationId),
  ],
);

// ── Biometric identity evidence (rls/0034, ADR-037) ──────────────
// Append-only by trigger; the CHECK constraints (closed vocabularies,
// score ranges, hex digests) live in the SQL, which is the system of record.
export const rnpBiometricEvidence = rnpOps.table(
  'biometric_evidence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recordId: uuid('record_id').notNull(),
    applicationId: uuid('application_id')
      .references(() => rnpApplications.id)
      .notNull(),
    ticketId: varchar('ticket_id', { length: 64 }).notNull(),
    referenceSource: varchar('reference_source', { length: 16 }).notNull(),
    method: varchar('method', { length: 24 }).notNull(),
    consentState: varchar('consent_state', { length: 24 }).notNull(),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    notAttemptedReason: varchar('not_attempted_reason', { length: 32 }),
    livenessScoreBp: integer('liveness_score_bp'),
    matchScoreBp: integer('match_score_bp'),
    modelId: varchar('model_id', { length: 64 }),
    modelVersion: varchar('model_version', { length: 32 }),
    thresholdPolicyVersion: varchar('threshold_policy_version', { length: 32 }).notNull(),
    mode: varchar('mode', { length: 16 }).notNull(),
    deviceId: varchar('device_id', { length: 64 }).notNull(),
    keyId: char('key_id', { length: 64 }).notNull(),
    recordDigest: char('record_digest', { length: 64 }).notNull(),
    signature: varchar('signature', { length: 88 }).notNull(),
    officerId: uuid('officer_id').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    correlationId: varchar('correlation_id', { length: 128 }),
  },
  (t) => [
    uniqueIndex('idx_rnp_biometric_evidence_record').on(t.recordId),
    index('idx_rnp_biometric_evidence_application').on(t.applicationId, t.receivedAt),
  ],
);

export const rnpGateManualIdentityConfirmations = rnpOps.table(
  'gate_manual_identity_confirmations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    evidenceId: uuid('evidence_id')
      .references(() => rnpBiometricEvidence.id)
      .notNull(),
    applicationId: uuid('application_id')
      .references(() => rnpApplications.id)
      .notNull(),
    ticketId: varchar('ticket_id', { length: 64 }).notNull(),
    reasonCode: varchar('reason_code', { length: 48 }).notNull(),
    confirmedById: uuid('confirmed_by_id').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).defaultNow().notNull(),
    correlationId: varchar('correlation_id', { length: 128 }),
  },
  (t) => [
    uniqueIndex('idx_rnp_gate_manual_identity_evidence').on(t.evidenceId),
    index('idx_rnp_gate_manual_identity_application').on(t.applicationId),
  ],
);
