// ══════════════════════════════════════════════════════════════════
// public_core schema — Shared applicant identity
// Visible to all agency services via their roles
// PII columns encrypted using pgcrypto (AES-256)
// Decryption requires the app.encryption_key session variable
// ══════════════════════════════════════════════════════════════════

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

    // Phone — hashed for lookup, not stored plaintext
    phoneNumberHash: varchar('phone_number_hash', { length: 64 }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),

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
