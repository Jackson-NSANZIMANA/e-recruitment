// ══════════════════════════════════════════════════════════════════
// field-sync-service — DeviceRegistry port
//
// The trust anchor for offline score capture. Enrollment binds a tablet's
// Ed25519 PUBLIC key to the agency that enrolled it; verification looks the key
// up by device id before trusting any signed record. Backed by
// public_core.field_devices (ADR-010 §2), written as usrp_system_service.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

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
  | { readonly kind: 'ALREADY_ENROLLED'; readonly agency: Agency };

export interface DeviceRegistry {
  enroll(input: EnrollDeviceInput): Promise<EnrollOutcome>;
  /** The device by id, or null if never enrolled. Revocation is a field, not a delete. */
  find(deviceId: string): Promise<DeviceRecord | null>;
}
