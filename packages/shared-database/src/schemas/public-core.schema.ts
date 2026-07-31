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
  pgEnum,
  index,
  uniqueIndex,
  text,
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

export const recruitmentCampaigns = publicCore.table(
  'recruitment_campaigns',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Human-readable label: "RDF-2026", "RCS-OFFICER-2026"
    campaignLabel: varchar('campaign_label', { length: 50 }).notNull().unique(),

    agency: agencyEnum('agency').notNull(),
    status: campaignStatusEnum('status').notNull().default('DRAFT'),

    // Application categories this campaign accepts (stored as JSON array)
    // e.g. ["GENERAL_ENLISTMENT","RESERVE_FORCE_ALEVEL"]
    targetCategories: text('target_categories').notNull(),

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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_pc_campaign_label').on(t.campaignLabel),
    index('idx_pc_campaign_agency').on(t.agency),
    index('idx_pc_campaign_status').on(t.status),
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
    capacityLimit: integer('capacity_limit'),                         // null = unlimited
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
