// ══════════════════════════════════════════════════════════════════
// @usrp/shared-types — Kafka Event Definitions
// Every event is immutable once published.
// Corrected: aligned with 10 official application categories
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationChannel, ApplicationCategory } from './agency.types';
import type { ApplicationStatus } from './applicant.types';
import type {
  AcademicEligibilityStatus,
  AgeEligibilityStatus,
  CriminalClearanceStatus,
  DocumentLane,
  DocumentType,
  EligibilityResult,
} from './eligibility.types';
import type { ForensicsFlags } from './vetting.types';

// ── Base Event ────────────────────────────────────────────────────

interface BaseEvent {
  readonly eventId: string;
  readonly eventVersion: '1.0';
  readonly occurredAt: string;         // ISO 8601 UTC
  readonly correlationId: string;      // Traces one request across all services
  readonly causationId: string;        // ID of the event that caused this one
}

// ── Topic: applicant.submitted ────────────────────────────────────

export interface ApplicantSubmittedEvent extends BaseEvent {
  readonly eventType: 'APPLICANT_SUBMITTED';
  readonly applicantId: string;
  readonly applicationId: string;   // The filed application this submission created
  readonly nationalIdHash: string;
  readonly agency: Agency;
  readonly category: ApplicationCategory;
  readonly channel: ApplicationChannel;
  // Academic verification inputs
  readonly nesaIndexNumber: string | null;      // null for degree holders
  readonly hecRegistrationNumber: string | null; // null for NESA-verified applicants
}

// ── Topic: vetting.nida ───────────────────────────────────────────

export interface NIDAVerificationCompletedEvent extends BaseEvent {
  readonly eventType: 'NIDA_VERIFICATION_COMPLETED';
  readonly applicantId: string;
  readonly nidaRequestId: string;
  readonly verified: boolean;
  readonly matchConfidence: number | null;
  readonly homeDistrict: string | null;  // From NIDA — drives exam slot assignment
  readonly homeProvince: string | null;
  readonly failureReason?: string;
}

// ── Topic: vetting.nesa ───────────────────────────────────────────

export interface NESAVerificationCompletedEvent extends BaseEvent {
  readonly eventType: 'NESA_VERIFICATION_COMPLETED';
  readonly applicantId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly category: ApplicationCategory;
  readonly nesaRequestId: string;
  readonly eligibilityResult: EligibilityResult;
  readonly academicStatus: AcademicEligibilityStatus;
}

// ── Topic: vetting.hec ───────────────────────────────────────────
// NEW: Higher Education Council — for degree/diploma holders

export interface HECVerificationCompletedEvent extends BaseEvent {
  readonly eventType: 'HEC_VERIFICATION_COMPLETED';
  readonly applicantId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly category: ApplicationCategory;
  readonly hecRequestId: string;
  readonly degreeVerified: boolean;
  readonly institutionName: string | null;
  readonly degreeTitle: string | null;
  readonly graduationYear: number | null;
  readonly specialistField: string | null;  // e.g. 'MEDICINE' — drives age exception
  readonly eligibilityResult: EligibilityResult;
  readonly academicStatus: AcademicEligibilityStatus;
}

// ── Topic: vetting.rib ────────────────────────────────────────────

export interface RIBVettingCompletedEvent extends BaseEvent {
  readonly eventType: 'RIB_VETTING_COMPLETED';
  readonly applicantId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly category: ApplicationCategory;
  readonly ribRequestId: string;
  readonly clearanceStatus: CriminalClearanceStatus;
  // The applied threshold — critical for audit (different per agency/category)
  readonly appliedThreshold: 'ANY_CONVICTION' | 'IMPRISONMENT_GT_6MO' | 'IMPRISONMENT_GTE_6MO';
}

// ── Topic: vetting.age ────────────────────────────────────────────
// The age gate's applicationId-bearing result. Emitted alongside the age
// AUDIT_ENTRY when the gate runs event-driven (off APPLICANT_SUBMITTED, which
// carries the applicationId). It lets the application-service projection record
// the age dimension and — with academic + criminal — reach the positive
// terminal. INVARIANT: raw date of birth NEVER appears here; only the derived
// age and verdict, mirroring how the age AUDIT_ENTRY is DOB-free.

export interface AgeEligibilityCompletedEvent extends BaseEvent {
  readonly eventType: 'AGE_ELIGIBILITY_COMPLETED';
  readonly applicantId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly category: ApplicationCategory;
  readonly ageStatus: AgeEligibilityStatus;
  // DOB-free evidence — the derived age and the band actually applied.
  readonly ageAtEvaluation: number;
  readonly appliedMaxAge: number;
  readonly eligible: boolean;
  readonly reason: string;
}

// ── Topic: application.cleared ────────────────────────────────────
// Emitted by application-service's projection when an application reaches the
// positive eligibility terminal DOCUMENT_REVIEW_GREEN (age + academic + criminal
// all passed). The first "stage N complete" signal on the backbone: it triggers
// the next stage — scheduling-service assigns an exam slot off this event.

export interface ApplicationEligibilityClearedEvent extends BaseEvent {
  readonly eventType: 'APPLICATION_ELIGIBILITY_CLEARED';
  readonly applicationId: string;
  readonly applicantId: string;
  readonly agency: Agency;
  readonly campaignId: string;
  readonly category: ApplicationCategory;
}

// ── Topic: biometric.result ───────────────────────────────────────

export interface BiometricVerificationCompletedEvent extends BaseEvent {
  readonly eventType: 'BIOMETRIC_VERIFICATION_COMPLETED';
  readonly applicantId: string;
  readonly sessionId: string;
  readonly livenessScore: number;
  readonly livenessPass: boolean;
  readonly faceMatchConfidence: number;
  readonly faceMatchPass: boolean;
  // No biometric data in event — scores only. Raw frames purged.
}

// ── Topic: slot.assigned ──────────────────────────────────────────

export interface SlotAssignedEvent extends BaseEvent {
  readonly eventType: 'SLOT_ASSIGNED';
  readonly applicantId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly campaignId: string;          // Links to recruitment_campaigns table
  readonly slotId: string;
  readonly district: string;
  readonly venueName: string;
  readonly examDate: string;
  readonly reportingTimeHour: number;
  /**
   * Stable, unique TICKET ID for this invitation (≤64 chars). The DB unique
   * key and the anchor that physical-test field scores bind to
   * (SignableFieldPayload.qrInvitationCode). Opaque; NOT the QR the applicant
   * scans.
   */
  readonly qrInvitationCode: string;
  /**
   * The self-contained, OFFLINE-verifiable credential encoded into the
   * applicant's QR (ADR-009). Ed25519-signed over a PII-free claim set; a
   * venue/biometric/physical-test stage verifies it with the scheduling public
   * key without any DB round-trip. See SlotInvitationClaims.
   */
  readonly qrSignedToken: string;
}

/**
 * The PII-free claim set embedded in the signed slot-invitation QR (ADR-009).
 * Contains ONLY opaque ids and the PUBLIC venue location — never the raw home
 * district, DOB, name, or national id. The signed token is
 * `USRP-SLOT.v1.<base64url(canonicalJson(claims))>.<base64url(ed25519sig)>`.
 */
export interface SlotInvitationClaims {
  /** Credential schema version — enables format evolution. */
  readonly v: 1;
  /** Signing-key identifier so verifiers can select the right public key. */
  readonly keyId: string;
  /** Stable ticket id — identical to SlotAssignedEvent.qrInvitationCode. */
  readonly ticketId: string;
  readonly applicationId: string;
  readonly applicantId: string;
  readonly agency: Agency;
  readonly campaignId: string;
  readonly slotId: string;
  readonly venueName: string;
  readonly examDate: string;
  readonly reportingTimeHour: number;
  /** ISO-8601 issue time. */
  readonly issuedAt: string;
  /** ISO-8601 expiry — the invitation is rejected after the exam window. */
  readonly expiresAt: string;
}

// ── Topic: field.score.captured ───────────────────────────────────

export interface FieldScoreCapturedEvent extends BaseEvent {
  readonly eventType: 'FIELD_SCORE_CAPTURED';
  readonly applicationId: string;
  readonly agency: Agency;
  readonly campaignId: string;
  readonly deviceId: string;
  readonly capturingOfficerId: string;
  readonly vectorClock: Record<string, number>;
  readonly signedPayloadHash: string;
  readonly isWalkIn: boolean;            // Distinguishes pre-registered vs walk-in
}

// ── Topic: notification.delivered ─────────────────────────────────

export interface NotificationDeliveredEvent extends BaseEvent {
  readonly eventType: 'NOTIFICATION_DELIVERED';
  readonly applicantId: string;
  readonly applicationId: string;
  readonly agency: Agency;
  readonly notificationType: 'SLOT_INVITATION';
  readonly channel: 'SMS' | 'EMAIL';
  // The delivery OUTCOME only — PII-free. No phone/email, no QR token in the
  // event. PENDING_NO_CONTACT means the schedule is active but no deliverable
  // contact is on file yet (contact capture is a flagged follow-on).
  readonly deliveryStatus: 'DELIVERED' | 'PENDING_NO_CONTACT' | 'FAILED';
}

// ── Topic: document.forensics ─────────────────────────────────────

/**
 * A document forensics verdict (amber-lane trigger). Emitted by
 * document-forensics-service after analyzing the referenced object's REAL
 * bytes (virus scan + container/metadata + C2PA-manifest presence — the
 * bounded-real analyzer tier; perceptual/ML checks are a deferred program).
 * application-service projects the lane onto the application status:
 * RED → reject/adjudicate, AMBER → DOCUMENT_REVIEW_AMBER hold, GREEN → no-op.
 * PII-free: ids, enums, booleans and a score only — never document content.
 * No applicantId — partition-keyed by applicationId.
 */
export interface DocumentForensicsCompletedEvent extends BaseEvent {
  readonly eventType: 'DOCUMENT_FORENSICS_COMPLETED';
  readonly applicationId: string;
  readonly agency: Agency;
  readonly documentId: string;           // document_records row id
  readonly documentType: DocumentType;
  readonly lane: DocumentLane;
  readonly forensicsScore: number;       // 0-100 (100 = clean)
  readonly flags: ForensicsFlags;
}

// ── Topic: audit.immutable ────────────────────────────────────────

export interface AuditEvent extends BaseEvent {
  readonly eventType: 'AUDIT_ENTRY';
  readonly entityType: 'APPLICANT' | 'APPLICATION' | 'OFFICER' | 'SYSTEM' | 'CAMPAIGN';
  readonly entityId: string;
  readonly action: string;
  readonly performedBy: string;
  readonly agency: Agency | 'SYSTEM';
  readonly previousStatus?: ApplicationStatus;
  readonly newStatus?: ApplicationStatus;
  readonly ipAddress?: string;           // For security audit trail
  readonly metadata?: Record<string, unknown>;
}

// ── Union type ────────────────────────────────────────────────────

export type USRPEvent =
  | ApplicantSubmittedEvent
  | NIDAVerificationCompletedEvent
  | NESAVerificationCompletedEvent
  | HECVerificationCompletedEvent
  | RIBVettingCompletedEvent
  | AgeEligibilityCompletedEvent
  | ApplicationEligibilityClearedEvent
  | BiometricVerificationCompletedEvent
  | SlotAssignedEvent
  | FieldScoreCapturedEvent
  | NotificationDeliveredEvent
  | DocumentForensicsCompletedEvent
  | AuditEvent;

// ── Kafka Topic Names ─────────────────────────────────────────────

export const KAFKA_TOPICS = {
  APPLICANT_SUBMITTED: 'applicant.submitted',
  VETTING_NIDA: 'vetting.nida',
  VETTING_NESA: 'vetting.nesa',
  VETTING_HEC: 'vetting.hec',           // NEW — degree verification
  VETTING_RIB: 'vetting.rib',
  VETTING_AGE: 'vetting.age',           // NEW — age gate result (positive-terminal composition)
  APPLICATION_CLEARED: 'application.cleared', // NEW — eligibility passed → triggers scheduling
  BIOMETRIC_RESULT: 'biometric.result',
  SLOT_ASSIGNED: 'slot.assigned',
  FIELD_SCORE_CAPTURED: 'field.score.captured',
  NOTIFICATION_DELIVERED: 'notification.delivered', // NEW — invitation delivery outcome → PHYSICAL_TEST_SCHEDULED
  DOCUMENT_FORENSICS: 'document.forensics', // NEW — forensics verdict → amber-lane routing
  AUDIT_IMMUTABLE: 'audit.immutable',
} as const;

export type KafkaTopic = typeof KAFKA_TOPICS[keyof typeof KAFKA_TOPICS];
