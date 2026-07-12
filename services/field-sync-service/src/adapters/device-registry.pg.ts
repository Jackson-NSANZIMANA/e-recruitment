// ══════════════════════════════════════════════════════════════════
// field-sync-service — DeviceRegistry adapter (PostgreSQL)
//
// Reads/writes public_core.field_devices as usrp_system_service. Every query
// runs inside a transaction that first `SET LOCAL ROLE usrp_system_service` so
// the field_devices FORCE'd RLS policy (pc_fd_system) applies — usrp_app itself
// has no policy on the table. Enrollment is idempotent: a repeated device_id is
// a no-op, reported as ALREADY_ENROLLED (never an error, never a key rotation —
// rotation would be a deliberate revoke + re-enroll).
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { Agency } from '@usrp/shared-types';
import type {
  DeviceRecord,
  DeviceRegistry,
  EnrollDeviceInput,
  EnrollOutcome,
} from '../ports/device-registry.js';
import { FieldSyncPersistenceError } from '../domain/field-sync.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';

interface DeviceRow {
  readonly device_id: string;
  readonly public_key_pem: string;
  readonly agency: Agency;
  readonly revoked_at: Date | null;
}

export class PgDeviceRegistry implements DeviceRegistry {
  async enroll(input: EnrollDeviceInput): Promise<EnrollOutcome> {
    try {
      return await sql.begin(async (tx): Promise<EnrollOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;

        const inserted = await tx<{ device_id: string }[]>`
          INSERT INTO public_core.field_devices
            (device_id, public_key_pem, agency, enrolled_by)
          VALUES (
            ${input.deviceId},
            ${input.publicKeyPem},
            ${input.agency}::public_core.agency,
            ${input.enrolledBy}
          )
          ON CONFLICT (device_id) DO NOTHING
          RETURNING device_id
        `;

        if (inserted[0]) return { kind: 'ENROLLED' };

        // Already present — report the existing owning agency (idempotent).
        const existing = await tx<{ agency: Agency }[]>`
          SELECT agency FROM public_core.field_devices WHERE device_id = ${input.deviceId}
        `;
        const row = existing[0];
        if (!row) throw new FieldSyncPersistenceError('Device vanished during enrollment');
        return { kind: 'ALREADY_ENROLLED', agency: row.agency };
      });
    } catch (cause) {
      if (cause instanceof FieldSyncPersistenceError) throw cause;
      throw new FieldSyncPersistenceError('Failed to enroll device', { cause });
    }
  }

  async find(deviceId: string): Promise<DeviceRecord | null> {
    try {
      return await sql.begin(async (tx): Promise<DeviceRecord | null> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const rows = await tx<DeviceRow[]>`
          SELECT device_id, public_key_pem, agency, revoked_at
          FROM public_core.field_devices
          WHERE device_id = ${deviceId}
        `;
        const row = rows[0];
        if (!row) return null;
        return {
          deviceId: row.device_id,
          publicKeyPem: row.public_key_pem,
          agency: row.agency,
          revokedAt: row.revoked_at,
        };
      });
    } catch (cause) {
      throw new FieldSyncPersistenceError('Failed to read device', { cause });
    }
  }
}
