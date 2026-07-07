import type { Agency, ApplicationChannel, District, Province } from './agency.types';
import type { DocumentType } from './eligibility.types';

// ── Core Identity (NIDA-Anchored) ─────────────────────────────────

export type Gender = 'MALE' | 'FEMALE';

export type IdentityVerificationStatus =
  | 'PENDING'
  | 'VERIFIED'
  | 'FAILED'
  | 'EXPIRED';

export interface ApplicantIdentityCore {
  readonly id: string;
  readonly nationalIdHash: string;
  readonly gender: Gender;
  readonly nidaVerifiedAt: string | null;
  readonly nidaMatchConfidence: string | null;
  readonly identityStatus: IdentityVerificationStatus;
  readonly registrationChannel: ApplicationChannel;
  readonly homeDistrict: District | null;    // From NIDA — drives slot assignment
  readonly homeProvince: Province | null;
  readonly phoneVerifiedAt: string | null;
  readonly biometricVerifiedAt: string | null;
  readonly biometricPassedLiveness: boolean;
  readonly createdAt: string;
}

// ── Application Status Flow ───────────────────────────────────────
// Two paths: Pre-registered (digital) and Walk-in (RDF only)

export const APPLICATION_STATUSES = [
  // ── Path A: Pre-registered digital flow ──────────────────────
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
  // ── Path B: Walk-in flow (RDF only) ──────────────────────────
  'WALK_IN_REGISTERED',         // Captured by field officer tablet on exam day
  'WALK_IN_ON_SITE_VETTING',    // Basic eligibility check done on-site
  'WALK_IN_PHYSICAL_TEST',
  'WALK_IN_REJECTED',
] as const;

export type ApplicationStatus = typeof APPLICATION_STATUSES[number];

// ── Document Upload Status ────────────────────────────────────────

export type DocumentUploadStatus =
  | 'PENDING_UPLOAD'
  | 'UPLOADED'
  | 'VIRUS_SCAN_PASS'
  | 'FORENSICS_GREEN'
  | 'FORENSICS_AMBER'
  | 'FORENSICS_RED'
  | 'VERIFIED_VIA_API'     // Green lane — verified directly via NESA/HEC
  | 'REJECTED';

export interface DocumentRecord {
  readonly documentId: string;
  readonly documentType: DocumentType;
  readonly uploadStatus: DocumentUploadStatus;
  readonly minioObjectKey?: string;        // Encrypted object path
  readonly forensicsScore?: number;
  readonly verifiedAt?: string;
  readonly rejectionReason?: string;
}

// ── Processing Code ───────────────────────────────────────────────

export interface ProcessingCode {
  readonly code: string;                   // e.g. "RDF-90823"
  readonly agency: Agency;
  readonly sequenceNumber: number;
}

// ── Cross-Agency Lock ─────────────────────────────────────────────

export interface CrossAgencyLock {
  readonly lockedAt: string;
  readonly lockedByAgency: Agency;
  readonly reason: 'ACCEPTED' | 'IN_FINAL_STAGE';
}

// ── Slot Assignment ───────────────────────────────────────────────

export interface ExamVenue {
  readonly district: District;
  readonly province: Province;
  readonly venueName: string;             // e.g. "IPRC Kicukiro Stadium"
  readonly examDate: string;              // ISO 8601 date
  readonly reportingTimeHour: number;     // 8 = 8:00 AM, 9 = 9:00 AM
  readonly agency: Agency;
  readonly recruitmentCycleId: string;    // Links to active recruitment campaign
}

export interface SlotAssignment {
  readonly slotId: string;
  readonly agency: Agency;
  readonly venue: ExamVenue;
  readonly qrInvitationCode: string;
  readonly qrIssuedAt: string;
  readonly smsNotificationSentAt: string | null;
}
