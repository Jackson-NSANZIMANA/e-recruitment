// ══════════════════════════════════════════════════════════════════
// public_core schema — Shared applicant identity
// Visible to all agency services via their roles
// PII columns encrypted using pgcrypto (AES-256)
// Decryption requires the app.encryption_key session variable
// ══════════════════════════════════════════════════════════════════

import { sql } from 'drizzle-orm';
import {
  pgSchema,
  uuid,
  varchar,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
  text,
  jsonb,
  check,
  foreignKey,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const publicCore = pgSchema('public_core');

// ── Enums ──────────────────────────────────────────────────────────

export const applicationChannelEnum = publicCore.enum('application_channel', [
  'WEB',
  'USSD',
  'IREMBO_KIOSK',
  'WALK_IN',
]);

export const identityVerificationStatusEnum = publicCore.enum(
  'identity_verification_status',
  ['PENDING', 'VERIFIED', 'FAILED', 'EXPIRED'],
);

export const genderEnum = publicCore.enum('gender', ['MALE', 'FEMALE']);

export const campaignStatusEnum = publicCore.enum('campaign_status', [
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'EXAMINATION_ACTIVE',
  'COMPLETED',
  'CANCELLED',
]);

export const agencyEnum = publicCore.enum('agency', ['RDF', 'RNP', 'RCS']);

// ── applicant_identities ──────────────────────────────────────────
// One row per unique Rwandan citizen who initiates an application.
// PII stored encrypted — decrypted only by authorized queries.
// nationalIdHash is the system-wide applicant key (never raw NID).

export const applicantIdentities = publicCore.table(
  'applicant_identities',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // NIDA-anchored identity — set by NIDA response, never by user input
    // SHA-256 HMAC of the raw NID — used as lookup key
    nationalIdHash: varchar('national_id_hash', { length: 64 })
      .notNull()
      .unique(),

    // ── Encrypted PII (pgcrypto AES-256-CBC) ──────────────────────
    // These are TEXT columns storing the ciphertext from:
    // pgp_sym_encrypt(plaintext, current_setting('app.encryption_key'))
    // Never queried directly by application — always decrypt via view
    encryptedFullName: text('encrypted_full_name').notNull(),
    encryptedDateOfBirth: text('encrypted_date_of_birth').notNull(),
    encryptedHomeDistrict: text('encrypted_home_district').notNull(),
    encryptedHomeProvince: text('encrypted_home_province').notNull(),

    // The G2G subject hash: HMAC(NIDA-shared secret, NID) — the stable token
    // every government authority (NIDA/HEC/RIB) recognises for this citizen,
    // distinct from the USRP-private national_id_hash above. Encrypted at rest
    // (pgcrypto) because it is a citizen-linked, externally-meaningful
    // identifier. Written by identity-service at verification (the only place
    // that holds the raw NID); re-presented by G2G credential checks (e.g. HEC
    // degree→holder binding). Nullable: pre-existing rows predate it.
    encryptedNidaLookupHash: text('encrypted_nida_lookup_hash'),

    // Non-PII from NIDA — unencrypted for query performance
    gender: genderEnum('gender').notNull(),

    // NIDA verification metadata
    nidaVerificationRequestId: varchar('nida_verification_request_id', { length: 128 }),
    nidaVerifiedAt: timestamp('nida_verified_at', { withTimezone: true }),
    nidaMatchConfidence: varchar('nida_match_confidence', { length: 6 }),
    identityStatus: identityVerificationStatusEnum('identity_status')
      .notNull()
      .default('PENDING'),

    // Registration channel
    registrationChannel: applicationChannelEnum('registration_channel').notNull(),

    // Phone — HMAC for lookup + pgcrypto ciphertext for delivery (ADR-021).
    // The ciphertext is captured at OTP verification (rls/0018), decrypted only
    // by notification-service's PgContactResolver, and NULLed on erasure.
    phoneNumberHash: varchar('phone_number_hash', { length: 64 }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    encryptedPhoneNumber: text('encrypted_phone_number'),

    // Biometric session metadata (no biometric data stored)
    biometricSessionId: varchar('biometric_session_id', { length: 128 }),
    biometricVerifiedAt: timestamp('biometric_verified_at', { withTimezone: true }),
    biometricPassedLiveness: boolean('biometric_passed_liveness').default(false),
    biometricFaceMatchConfidence: varchar('biometric_face_match_confidence', { length: 6 }),

    // USSD reservation (72-hour expiry for incomplete USSD sessions)
    ussdReservationExpiresAt: timestamp('ussd_reservation_expires_at', { withTimezone: true }),
    ussdSessionCompletedAt: timestamp('ussd_session_completed_at', { withTimezone: true }),

    // Cross-agency lock — set when applicant is accepted by any agency
    crossAgencyLockedAt: timestamp('cross_agency_locked_at', { withTimezone: true }),
    crossAgencyLockedByAgency: agencyEnum('cross_agency_locked_by_agency'),
    crossAgencyLockReason: varchar('cross_agency_lock_reason', { length: 30 }),

    // Soft delete — data erasure path for Law N° 058/2021 compliance
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_pc_national_id_hash').on(t.nationalIdHash),
    index('idx_pc_identity_status').on(t.identityStatus),
    index('idx_pc_phone_hash').on(t.phoneNumberHash),
    index('idx_pc_created_at').on(t.createdAt),
  ],
);

// ── applicant_sessions ────────────────────────────────────────────
// Tracks active web and USSD sessions.
// Redis holds the live session data; this table holds the audit record.

export const applicantSessions = publicCore.table(
  'applicant_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicantId: uuid('applicant_id')
      .references(() => applicantIdentities.id)
      .notNull(),
    sessionToken: varchar('session_token', { length: 256 }).notNull().unique(),
    channel: applicationChannelEnum('channel').notNull(),
    // USSD state machine position (e.g., 'AWAIT_NID', 'AWAIT_AGENCY', 'COMPLETE')
    ussdState: varchar('ussd_state', { length: 50 }),
    ussdMenuDepth: integer('ussd_menu_depth').default(0),
    ipAddress: varchar('ip_address', { length: 45 }),   // IPv4 or IPv6
    userAgent: varchar('user_agent', { length: 512 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
    terminatedAt: timestamp('terminated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_pc_session_token').on(t.sessionToken),
    index('idx_pc_session_applicant').on(t.applicantId),
    index('idx_pc_session_expires').on(t.expiresAt),
  ],
);

// ── recruitment_campaigns ─────────────────────────────────────────
// One row per recruitment cycle per agency.
// Administrators create campaigns before opening registration.
// The system reads the active campaign to route applicants correctly.

function campaignPolicyVersionReferenceColumns(): [AnyPgColumn, AnyPgColumn, AnyPgColumn] {
  return [campaignPolicyVersions.id, campaignPolicyVersions.campaignId, campaignPolicyVersions.agency];
}

export const recruitmentCampaigns = publicCore.table(
  'recruitment_campaigns',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Human-readable label: "RDF-2026", "RCS-OFFICER-2026"
    campaignLabel: varchar('campaign_label', { length: 50 }).notNull().unique(),

    agency: agencyEnum('agency').notNull(),
    // Stable external addressing. Legacy rows are backfilled during 0002.
    publicCode: varchar('public_code', { length: 64 }).notNull(),
    status: campaignStatusEnum('status').notNull().default('DRAFT'),

    // Application categories this campaign accepts (stored as JSON array)
    // e.g. ["GENERAL_ENLISTMENT","RESERVE_FORCE_ALEVEL"]
    targetCategories: text('target_categories').notNull(),
    // Null on some legacy campaigns whose historical venue list was incomplete.
    targetDistricts: jsonb('target_districts').$type<readonly string[] | null>(),
    currentPolicyVersionId: uuid('current_policy_version_id'),

    // Registration window — from official announcements
    registrationOpensAt: timestamp('registration_opens_at', { withTimezone: true }).notNull(),
    registrationClosesAt: timestamp('registration_closes_at', { withTimezone: true }).notNull(),

    // Examination window
    examinationStartDate: varchar('examination_start_date', { length: 10 }).notNull(), // YYYY-MM-DD
    examinationEndDate: varchar('examination_end_date', { length: 10 }).notNull(),
    examinationReportingHour: integer('examination_reporting_hour').notNull(), // 8 or 9

    // Walk-in policy for this specific campaign
    allowsWalkIn: boolean('allows_walk_in').notNull().default(false),

    // Intake target (null = no cap defined)
    targetIntakeCount: integer('target_intake_count'),

    // Contact info from announcement
    contactPhoneNumbers: text('contact_phone_numbers'),   // JSON array of strings
    contactWebsite: varchar('contact_website', { length: 100 }),

    // Announcement source document reference
    announcementReference: varchar('announcement_reference', { length: 200 }),

    publishedAt: timestamp('published_at', { withTimezone: true }),
    registrationClosedAt: timestamp('registration_closed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_pc_campaign_label').on(t.campaignLabel),
    uniqueIndex('idx_pc_campaign_public_code').on(t.publicCode),
    uniqueIndex('idx_pc_campaign_id_agency').on(t.id, t.agency),
    index('idx_pc_campaign_agency').on(t.agency),
    index('idx_pc_campaign_status').on(t.status),
    check('campaign_public_code_format_check', sql`public_code ~ '^[A-Z0-9][A-Z0-9-]{2,63}$'`),
    check(
      'campaign_target_districts_array_check',
      sql`target_districts IS NULL OR jsonb_typeof(target_districts) = 'array'`,
    ),
    foreignKey({
      name: 'campaign_current_policy_same_campaign_fk',
      columns: [t.currentPolicyVersionId, t.id, t.agency],
      foreignColumns: campaignPolicyVersionReferenceColumns(),
    }).onDelete('restrict').onUpdate('restrict'),
  ],
);

// ── field_devices ─────────────────────────────────────────────────
// Registry of enrolled field tablets (ADR-010). Each row binds a device's
// Ed25519 PUBLIC key to the agency that enrolled it; field-sync-service
// verifies every uploaded physical-test score's device_signature against it
// before accepting the score. Revocation is a timestamp, not a delete — what a
// device was trusted to sign is retained. Actual DDL + FORCE'd RLS live in
// rls/0009 (this definition mirrors it as the readable schema source of truth).

export const fieldDevices = publicCore.table(
  'field_devices',
  {
    // The device identifier signed into every score record (SignableFieldPayload.deviceId).
    deviceId: varchar('device_id', { length: 64 }).primaryKey(),
    // SPKI PEM of the device's Ed25519 public key — the trust anchor.
    publicKeyPem: text('public_key_pem').notNull(),
    agency: agencyEnum('agency').notNull(),
    // Enrolling officer's opaque subject id (from their verified token).
    enrolledBy: varchar('enrolled_by', { length: 128 }).notNull(),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).defaultNow().notNull(),
    // NULL = active; set = no longer trusted (verification rejects revoked devices).
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('idx_pc_field_devices_agency').on(t.agency)],
);

// ── campaign_venue_assignments ────────────────────────────────────
// Maps each district to its exam venue for a given campaign.
// Data seeded from official announcements.
// One row per district per campaign (30 rows for full national coverage).

export const campaignVenueAssignments = publicCore.table(
  'campaign_venue_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id')
      .references(() => recruitmentCampaigns.id)
      .notNull(),

    // Location — from official announcements
    district: varchar('district', { length: 30 }).notNull(),
    province: varchar('province', { length: 30 }).notNull(),
    venueName: varchar('venue_name', { length: 200 }).notNull(),

    // Exam schedule for this venue
    examDate: varchar('exam_date', { length: 10 }).notNull(),        // YYYY-MM-DD
    reportingTimeHour: integer('reporting_time_hour').notNull(),     // 8 or 9

    // Capacity management
    capacityLimit: integer('capacity_limit'),                         // null = unbounded only with explicit decision for BUILD-001
    capacityDecisionCode: varchar('capacity_decision_code', { length: 64 }),
    registeredCount: integer('registered_count').notNull().default(0),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_pc_venue_campaign').on(t.campaignId),
    index('idx_pc_venue_district').on(t.district),
    uniqueIndex('idx_pc_venue_campaign_district').on(t.campaignId, t.district),
  ],
);

// ── BUILD-001 Campaign & Policy Control Plane ─────────────────────
// Tables below are agency-scoped. Their RLS and command-function write
// boundary are provisioned by rls/0026_campaign_control_plane.sql and
// rls/0027_campaign_command_functions.sql.

export const campaignPolicyVersions = publicCore.table(
  'campaign_policy_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    agency: agencyEnum('agency').notNull(),
    versionNumber: integer('version_number').notNull(),
    policyDocument: jsonb('policy_document').$type<Readonly<Record<string, unknown>>>().notNull(),
    // Exact canonical v1 serialization is retained so PostgreSQL can verify the
    // digest independently of JSONB key ordering/number formatting.
    canonicalPolicyJson: text('canonical_policy_json'),
    policyHash: varchar('policy_hash', { length: 64 }).notNull(),
    hashVersion: integer('hash_version').notNull(),
    legalBasisCode: varchar('legal_basis_code', { length: 64 }).notNull(),
    legalBasisReference: varchar('legal_basis_reference', { length: 256 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_pc_policy_campaign_version').on(t.campaignId, t.versionNumber),
    uniqueIndex('idx_pc_policy_id_campaign_agency').on(t.id, t.campaignId, t.agency),
    index('idx_pc_policy_campaign').on(t.campaignId),
    check('campaign_policy_versions_version_positive_check', sql`version_number > 0`),
    check('campaign_policy_versions_hash_check', sql`policy_hash ~ '^[0-9a-f]{64}$'`),
    check('campaign_policy_versions_hash_version_check', sql`hash_version = 1`),
    check('campaign_policy_versions_document_object_check', sql`jsonb_typeof(policy_document) = 'object'`),
    check(
      'campaign_policy_versions_legal_basis_check',
      sql`length(btrim(legal_basis_code)) > 0 AND length(btrim(legal_basis_reference)) > 0`,
    ),
    foreignKey({
      name: 'campaign_policy_versions_campaign_agency_fk',
      columns: [t.campaignId, t.agency],
      foreignColumns: [recruitmentCampaigns.id, recruitmentCampaigns.agency],
    }).onDelete('restrict').onUpdate('restrict'),
  ],
);

export const campaignPublications = publicCore.table(
  'campaign_publications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    agency: agencyEnum('agency').notNull(),
    publicCode: varchar('public_code', { length: 64 }).notNull(),
    policyVersionId: uuid('policy_version_id').notNull(),
    coverageVersion: integer('coverage_version').notNull(),
    coverageHash: varchar('coverage_hash', { length: 64 }).notNull(),
    publicationEventId: uuid('publication_event_id').notNull(),
    publishedBy: uuid('published_by').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_pc_publication_campaign').on(t.campaignId),
    uniqueIndex('idx_pc_publication_id_campaign_agency').on(t.id, t.campaignId, t.agency),
    index('idx_pc_publication_agency_published').on(t.agency, t.publishedAt),
    unique('campaign_publications_event_unique').on(t.publicationEventId),
    check('campaign_publications_coverage_version_check', sql`coverage_version > 0`),
    check('campaign_publications_coverage_hash_check', sql`coverage_hash ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      name: 'campaign_publications_campaign_agency_fk',
      columns: [t.campaignId, t.agency],
      foreignColumns: [recruitmentCampaigns.id, recruitmentCampaigns.agency],
    }).onDelete('restrict').onUpdate('restrict'),
    foreignKey({
      name: 'campaign_publications_policy_campaign_fk',
      columns: [t.policyVersionId, t.campaignId, t.agency],
      foreignColumns: [campaignPolicyVersions.id, campaignPolicyVersions.campaignId, campaignPolicyVersions.agency],
    }).onDelete('restrict').onUpdate('restrict'),
  ],
);

export const campaignLifecycleHistory = publicCore.table(
  'campaign_lifecycle_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    agency: agencyEnum('agency').notNull(),
    fromStatus: campaignStatusEnum('from_status'),
    toStatus: campaignStatusEnum('to_status').notNull(),
    actorId: uuid('actor_id').notNull(),
    correlationId: varchar('correlation_id', { length: 128 }).notNull(),
    reasonCode: varchar('reason_code', { length: 64 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_pc_campaign_history_campaign_time').on(t.campaignId, t.occurredAt),
    check(
      'campaign_lifecycle_history_legal_edge_check',
      sql`(from_status IS NULL AND to_status = 'DRAFT') OR
        (from_status IS NOT NULL AND from_status = 'DRAFT' AND to_status IN ('REGISTRATION_OPEN', 'CANCELLED')) OR
        (from_status IS NOT NULL AND from_status = 'REGISTRATION_OPEN' AND to_status IN ('REGISTRATION_CLOSED', 'CANCELLED')) OR
        (from_status IS NOT NULL AND from_status = 'REGISTRATION_CLOSED' AND to_status = 'COMPLETED')`,
    ),
    foreignKey({
      name: 'campaign_lifecycle_history_campaign_agency_fk',
      columns: [t.campaignId, t.agency],
      foreignColumns: [recruitmentCampaigns.id, recruitmentCampaigns.agency],
    }).onDelete('restrict').onUpdate('restrict'),
  ],
);

export const campaignCommandRequests = publicCore.table(
  'campaign_command_requests',
  {
    commandId: uuid('command_id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').notNull(),
    agency: agencyEnum('agency').notNull(),
    operation: varchar('operation', { length: 48 }).notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    resourceId: uuid('resource_id').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<Readonly<Record<string, unknown>>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_pc_campaign_command_actor_operation_key').on(t.actorId, t.operation, t.idempotencyKey),
    index('idx_pc_campaign_command_resource').on(t.resourceId, t.createdAt),
    check('campaign_command_requests_hash_check', sql`request_hash ~ '^[0-9a-f]{64}$'`),
    check('campaign_command_requests_response_status_check', sql`response_status BETWEEN 200 AND 299`),
    check('campaign_command_requests_response_object_check', sql`jsonb_typeof(response_body) = 'object'`),
  ],
);

export const campaignCoverageHeads = publicCore.table(
  'campaign_coverage_heads',
  {
    campaignId: uuid('campaign_id').primaryKey(),
    agency: agencyEnum('agency').notNull(),
    coverageVersion: integer('coverage_version').notNull(),
    coverageHash: varchar('coverage_hash', { length: 64 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('campaign_coverage_heads_version_check', sql`coverage_version >= 0`),
    check('campaign_coverage_heads_hash_check', sql`coverage_hash ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      name: 'campaign_coverage_heads_campaign_agency_fk',
      columns: [t.campaignId, t.agency],
      foreignColumns: [recruitmentCampaigns.id, recruitmentCampaigns.agency],
    }).onDelete('restrict').onUpdate('restrict'),
  ],
);

export const sessionCommandRequests = publicCore.table(
  'session_command_requests',
  {
    commandId: uuid('command_id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').notNull(),
    agency: agencyEnum('agency').notNull(),
    actorId: uuid('actor_id').notNull(),
    operation: varchar('operation', { length: 48 }).notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').$type<Readonly<Record<string, unknown>>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_pc_session_command_actor_operation_key').on(
      t.actorId,
      t.operation,
      t.idempotencyKey,
    ),
    index('idx_pc_session_command_campaign').on(t.campaignId, t.createdAt),
    check('session_command_requests_hash_check', sql`request_hash ~ '^[0-9a-f]{64}$'`),
    check('session_command_requests_response_status_check', sql`response_status BETWEEN 200 AND 299`),
    check('session_command_requests_response_object_check', sql`jsonb_typeof(response_body) = 'object'`),
    foreignKey({
      name: 'session_command_requests_campaign_agency_fk',
      columns: [t.campaignId, t.agency],
      foreignColumns: [recruitmentCampaigns.id, recruitmentCampaigns.agency],
    }).onDelete('restrict').onUpdate('restrict'),
  ],
);

// ── officer_accounts ──────────────────────────────────────────────
// The FIRST human-account table: the token issuer's credential store. iam-service
// verifies an officer's login_handle + password (scrypt digest — never plaintext)
// and mints an Ed25519 bearer token whose `sub` is officer_id (a UUID, so it lands
// in the UUID medical_reviewed_by_id / final_decision_by_id stamp columns). Read
// and written by usrp_iam_service ALONE (least privilege on the crown jewels).
// Actual DDL + FORCE'd RLS live in rls/0010 (this mirrors it as the readable
// schema source of truth).

export const officerAccounts = publicCore.table(
  'officer_accounts',
  {
    // = the minted token's `sub` claim. UUID to match the officer-stamp columns.
    officerId: uuid('officer_id').defaultRandom().primaryKey(),
    loginHandle: varchar('login_handle', { length: 128 }).notNull().unique(),
    // scrypt$N$r$p$saltB64$hashB64 (shared-security hashPassword) — NEVER plaintext.
    credential: text('credential').notNull(),
    agency: agencyEnum('agency').notNull(),
    roles: text('roles').array().notNull().default([]),
    // 'active' | 'disabled' — CHECK constraint enforced in rls/0010.
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('idx_pc_officer_accounts_handle').on(t.loginHandle)],
);

// ── service_accounts ──────────────────────────────────────────────
// The MACHINE mirror of officer_accounts (ADR-016). A service client presents
// { clientId, clientSecret } to iam-service's client-credentials grant; the
// secret is verified against the scrypt digest stored here and a short-lived
// (15 min) Ed25519 kind:'system' token is minted with service_id as its `sub`.
// Read and written by usrp_iam_service ALONE — deliberately NOT granted to
// usrp_system_service, so a compromised worker cannot harvest the credentials
// that mint its own kind of token. Actual DDL + FORCE'd RLS live in rls/0015
// (this mirrors it as the readable schema source of truth).

export const serviceAccounts = publicCore.table(
  'service_accounts',
  {
    // = the minted token's `sub` claim.
    serviceId: uuid('service_id').defaultRandom().primaryKey(),
    clientId: varchar('client_id', { length: 128 }).notNull().unique(),
    // scrypt$N$r$p$saltB64$hashB64 (shared-security hashPassword) — NEVER plaintext.
    credential: text('credential').notNull(),
    description: varchar('description', { length: 200 }),
    // 'active' | 'disabled' — CHECK constraint enforced in rls/0015.
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('idx_pc_service_accounts_client').on(t.clientId)],
);

// ── applicant_otp_challenges ──────────────────────────────────────
// The citizen login challenge (ADR-018). An OTP is sent to the phone NIDA has
// on file (fetched live, never stored raw) and only its scrypt digest is kept
// here — the code itself is never persisted. Single-use (consumed_at), 5-minute
// TTL (expires_at), 5-attempt lockout (attempts). Erasure deletes a citizen's
// challenges outright. Actual DDL + grants live in rls/0016 (this mirrors it as
// the readable schema source of truth).

export const applicantOtpChallenges = publicCore.table(
  'applicant_otp_challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicantId: uuid('applicant_id')
      .references(() => applicantIdentities.id)
      .notNull(),
    // scrypt digest of the 6-digit code — NEVER plaintext.
    otpHash: text('otp_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    // NULL = still redeemable; set = spent (single-use).
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  // The verify path looks up the newest live challenge for an applicant.
  (t) => [index('idx_pc_otp_applicant').on(t.applicantId, t.createdAt.desc())],
);

// ── erasure_requests ──────────────────────────────────────────────
// The DPO intake queue (ADR-020, owner D10). A citizen's erasure demand is
// QUEUED here rather than executed directly — an OTP session is too weak an
// authority for irreversible destruction. An officer later executes it (the
// ADR-015 road, which stamps this row EXECUTED) or declines it with a ground.
// Rows deliberately SURVIVE the erasure they record: the request is a
// PII-free legal-obligation record, not applicant data. Actual DDL + the two
// CHECK constraints (status domain; all-or-nothing decision stamp) live in
// rls/0017 (this mirrors it as the readable schema source of truth).

export const erasureRequests = publicCore.table(
  'erasure_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicantId: uuid('applicant_id')
      .references(() => applicantIdentities.id)
      .notNull(),
    // 'PENDING' | 'EXECUTED' | 'DECLINED' — CHECK constraint enforced in rls/0017.
    status: varchar('status', { length: 10 }).notNull().default('PENDING'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    // Officer UUID (token `sub`) for EXECUTED / DECLINED; NULL while PENDING.
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // Decline ground; NULL for EXECUTED is fine.
    decisionNote: varchar('decision_note', { length: 200 }),
  },
  (t) => [
    // At most ONE open request per citizen (partial unique — PENDING only).
    uniqueIndex('idx_pc_erasure_request_pending')
      .on(t.applicantId)
      .where(sql`status = 'PENDING'`),
    // The DPO queue reads oldest-first; the citizen reads their own newest.
    index('idx_pc_erasure_request_applicant').on(t.applicantId, t.requestedAt.desc()),
  ],
);
