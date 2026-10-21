// ══════════════════════════════════════════════════════════════════
// field-sync-service — DeviceRegistry port
//
// The trust anchor for offline score capture. Enrollment binds a tablet's
// Ed25519 PUBLIC key to the agency that enrolled it; verification looks the key
// up by device id before trusting any signed record. Backed by
// public_core.field_devices (ADR-010 §2), written as usrp_system_service.
// ══════════════════════════════════════════════════════════════════

import type { Agency, AuditEvent } from '@usrp/shared-types';

/** A device as trusted by the registry. `revokedAt` set ⇒ no longer trusted. */
export interface DeviceRecord {
  readonly deviceId: string;
  readonly publicKeyPem: string;
  readonly agency: Agency;
  readonly revokedAt: Date | null;
}

export interface EnrollDeviceInput {
  readonly deviceId: string;
  readonly publicKeyPem: string;
  /** Owning agency — taken from the enrolling officer's token, never the body. */
  readonly agency: Agency;
  /** Enrolling officer's opaque subject id. */
  readonly enrolledBy: string;
}

export type EnrollOutcome =
  | { readonly kind: 'ENROLLED' }
  /** device_id already present — idempotent re-enrollment, nothing changed. */
  | { readonly kind: 'ALREADY_ENROLLED'; readonly agency: Agency }
  /** device_id belongs to a revoked device: a revocation is final, enrol a NEW device id. */
  | { readonly kind: 'REVOKED' };

/** Closed vocabulary: no free text, so the audit stays PII-free (rls/0036). */
export const REVOKE_REASONS = ['LOST', 'STOLEN', 'COMPROMISED', 'RETIRED', 'OTHER'] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/** Which service saw the device sign something. */
export type ContactSource = 'FIELD_SYNC' | 'BIOMETRIC';

/** One row of the fleet list. NEVER carries the key. */
export interface FleetDevice {
  readonly deviceId: string;
  readonly enrolledBy: string;
  readonly enrolledAt: string;
  readonly lastSeenAt: string | null;
  readonly lastSeenSource: ContactSource | null;
  readonly lastSyncAt: string | null;
  readonly revokedAt: string | null;
  readonly revokeReason: RevokeReason | null;
  /** The most recent venue-day binding, or null. */
  readonly assignment: {
    readonly campaignPublicCode: string;
    readonly district: string;
    readonly examDate: string;
  } | null;
}

export interface RevokeDeviceInput {
  readonly deviceId: string;
  /** From the session; a device of another agency is NOT_FOUND. */
  readonly agency: Agency;
  readonly revokedBy: string;
  readonly reason: RevokeReason;
  /** Staged in the transactional outbox IN THE SAME TRANSACTION as the revocation. */
  readonly audit: AuditEvent;
}
export type RevokeOutcome =
  | { readonly kind: 'REVOKED' }
  | { readonly kind: 'ALREADY_REVOKED' }
  | { readonly kind: 'NOT_FOUND' };

export interface AssignDeviceInput {
  readonly deviceId: string;
  readonly agency: Agency;
  readonly campaignPublicCode: string;
  readonly district: string;
  readonly examDate: string;
  readonly assignedBy: string;
  /** Staged in the transactional outbox in the same transaction as the binding. */
  readonly audit: AuditEvent;
}
export type AssignOutcome =
  | { readonly kind: 'ASSIGNED' }
  | { readonly kind: 'DEVICE_NOT_FOUND' }
  | { readonly kind: 'DEVICE_REVOKED' }
  | { readonly kind: 'VENUE_NOT_FOUND' };

export interface DeviceRegistry {
  enroll(input: EnrollDeviceInput): Promise<EnrollOutcome>;
  /** The device by id, or null if never enrolled. Revocation is a field, not a delete. */
  find(deviceId: string): Promise<DeviceRecord | null>;
  /**
   * The agency's fleet, newest enrolment first. Runs under the OFFICER's own
   * database role, so a sibling agency's rows are filtered by the engine.
   */
  list(scope: { readonly agency: Agency; readonly dbRole: string }): Promise<readonly FleetDevice[]>;
  revoke(input: RevokeDeviceInput): Promise<RevokeOutcome>;
  assign(input: AssignDeviceInput): Promise<AssignOutcome>;
  /** Stamp last-seen (monotonic) after a SIGNED contact. Never throws for an unknown device. */
  touch(deviceId: string, source: ContactSource): Promise<void>;
}
