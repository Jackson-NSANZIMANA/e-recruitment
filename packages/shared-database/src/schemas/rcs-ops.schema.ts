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
  'ADJUDICATION_REVIEW',
  'REJECTED',
  'WITHDRAWN',
]);

export const rcsAcademicStatusEnum = rcsOps.enum('academic_eligibility_status', [
  'PENDING', 'ELIGIBLE', 'INELIGIBLE',
]);

export const rcsAgeStatusEnum = rcsOps.enum('age_eligibility_status', [
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
// NOT MODELLED HERE (deliberate, ADR-027): the live-intent partial unique
// index applied by rls/0022_submission_integrity.sql —
//   uq_rcs_applications_live_intent
//     ON rcs_ops.applications (applicant_id, campaign_id, category)
//     WHERE status <> 'WITHDRAWN'
// It is the engine's guarantee that one citizen holds at most ONE live
// application per campaign+category. It is omitted from the mirror for the
// same reason CHECK constraints are (see docs/architecture/schema-evolution.md):
// verify-schema-drift.ts compares only `idx_*`-named indexes, so adding a
// `uq_`-named one to the snapshot would make the drift gate red forever.
// Its existence, uniqueness and exact predicate are asserted against the LIVE
// database instead, by
// services/application-service/selfcheck/verify-submission-integrity.ts §2.

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

    // ── Age vetting (projected from the age gate; DOB-free detail) ──
    ageEligibilityStatus: rcsAgeStatusEnum('age_eligibility_status').notNull().default('PENDING'),
    ageVerifiedAt: timestamp('age_verified_at', { withTimezone: true }),
    ageEligibilityDetail: jsonb('age_eligibility_detail'),

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
    uniqueIndex('idx_rcs_processing_code').on(t.processingCode),
    index('idx_rcs_applicant_id').on(t.applicantId),
    index('idx_rcs_campaign_id').on(t.campaignId),
    index('idx_rcs_status').on(t.status),
    // rls/0035 (ADR-039): keyset order of the officer application search, and the venue roster.
    index('idx_rcs_applications_read_keyset').on(sql`(COALESCE(submitted_at, created_at)) DESC`, t.id.desc()),
    index('idx_rcs_applications_roster')
      .on(t.campaignId, t.assignedDistrict)
      .where(sql`assigned_district IS NOT NULL`),
    index('idx_rcs_document_lane').on(t.documentLane),
    index('idx_rcs_academic_status').on(t.academicStatus),
    index('idx_rcs_age_status').on(t.ageEligibilityStatus),
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

    // Venue verification (rls/0030, ADR-032): the check-in officer saw the
    // paper. Write-once. At most one per (application, type) — enforced by the
    // partial unique index uq_rcs_docs_venue_once, asserted live, not mirrored.
    venueVerifiedById: uuid('venue_verified_by_id'),
    venueVerifiedAt: timestamp('venue_verified_at', { withTimezone: true }),
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

// ── Gate admission (rls/0032, BUILD-003, ADR-034) ─────────────────
// One immutable row per admitted application; single use is the pair of
// unique indexes. Append-only by trigger (not modelled here), as is the
// attempts log, which records every scan, refused or not, PII-free.

export const rcsGateAdmissions = rcsOps.table(
  'gate_admissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rcsApplications.id)
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
    uniqueIndex('idx_rcs_gate_admissions_application').on(t.applicationId),
    uniqueIndex('idx_rcs_gate_admissions_ticket').on(t.ticketId),
  ],
);

export const rcsGateAdmissionAttempts = rcsOps.table(
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
    index('idx_rcs_gate_attempts_application').on(t.applicationId),
  ],
);

// ── Biometric identity evidence (rls/0034, ADR-037) ──────────────
// Append-only by trigger; the CHECK constraints (closed vocabularies,
// score ranges, hex digests) live in the SQL, which is the system of record.
export const rcsBiometricEvidence = rcsOps.table(
  'biometric_evidence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recordId: uuid('record_id').notNull(),
    applicationId: uuid('application_id')
      .references(() => rcsApplications.id)
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
    uniqueIndex('idx_rcs_biometric_evidence_record').on(t.recordId),
    index('idx_rcs_biometric_evidence_application').on(t.applicationId, t.receivedAt),
  ],
);

export const rcsGateManualIdentityConfirmations = rcsOps.table(
  'gate_manual_identity_confirmations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    evidenceId: uuid('evidence_id')
      .references(() => rcsBiometricEvidence.id)
      .notNull(),
    applicationId: uuid('application_id')
      .references(() => rcsApplications.id)
      .notNull(),
    ticketId: varchar('ticket_id', { length: 64 }).notNull(),
    reasonCode: varchar('reason_code', { length: 48 }).notNull(),
    confirmedById: uuid('confirmed_by_id').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).defaultNow().notNull(),
    correlationId: varchar('correlation_id', { length: 128 }),
  },
  (t) => [
    uniqueIndex('idx_rcs_gate_manual_identity_evidence').on(t.evidenceId),
    index('idx_rcs_gate_manual_identity_application').on(t.applicationId),
  ],
);

// ── Irembo clearance-certificate verifications (rls/0040, ADR-048 §2.3-2.4) ──
// Append-only by trigger and written only through the SECURITY DEFINER
// record_clearance_verification. NO name and NO date of birth: the reference
// is an HMAC plus its last 4 characters. The CHECK constraints (closed
// vocabularies, outcome/code consistency) live in the SQL, the system of record.
export const rcsClearanceCertificateVerifications = rcsOps.table(
  'clearance_certificate_verifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .references(() => rcsApplications.id)
      .notNull(),
    referenceHmac: char('reference_hmac', { length: 64 }).notNull(),
    referenceLast4: char('reference_last4', { length: 4 }).notNull(),
    certificateType: varchar('certificate_type', { length: 64 }),
    issuedOn: date('issued_on'),
    outcome: varchar('outcome', { length: 24 }).notNull(),
    failureCode: varchar('failure_code', { length: 48 }),
    reviewReasons: text('review_reasons').array().default(sql`ARRAY[]::text[]`).notNull(),
    binding: jsonb('binding'),
    source: varchar('source', { length: 24 }).default('IREMBO_CERTIFICATE').notNull(),
    upstreamTraceId: varchar('upstream_trace_id', { length: 64 }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
    correlationId: varchar('correlation_id', { length: 128 }),
  },
  (t) => [
    index('idx_rcs_clearance_verif_application').on(t.applicationId, t.verifiedAt.desc()),
  ],
);
