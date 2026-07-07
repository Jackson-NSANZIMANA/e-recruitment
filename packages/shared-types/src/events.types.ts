// ══════════════════════════════════════════════════════════════════
// @usrp/shared-types — Kafka Event Definitions
// Every event is immutable once published.
// Corrected: aligned with 10 official application categories
// ══════════════════════════════════════════════════════════════════

import type { Agency, ApplicationChannel, ApplicationCategory } from './agency.types';
import type { ApplicationStatus } from './applicant.types';
import type {
  AcademicEligibilityStatus,
  CriminalClearanceStatus,
  EligibilityResult,
} from './eligibility.types';

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
  readonly qrInvitationCode: string;
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
  | BiometricVerificationCompletedEvent
  | SlotAssignedEvent
  | FieldScoreCapturedEvent
  | AuditEvent;

// ── Kafka Topic Names ─────────────────────────────────────────────

export const KAFKA_TOPICS = {
  APPLICANT_SUBMITTED: 'applicant.submitted',
  VETTING_NIDA: 'vetting.nida',
  VETTING_NESA: 'vetting.nesa',
  VETTING_HEC: 'vetting.hec',           // NEW — degree verification
  VETTING_RIB: 'vetting.rib',
  BIOMETRIC_RESULT: 'biometric.result',
  SLOT_ASSIGNED: 'slot.assigned',
  FIELD_SCORE_CAPTURED: 'field.score.captured',
  AUDIT_IMMUTABLE: 'audit.immutable',
} as const;

export type KafkaTopic = typeof KAFKA_TOPICS[keyof typeof KAFKA_TOPICS];
