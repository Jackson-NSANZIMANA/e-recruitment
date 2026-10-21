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

import { sql, stageOutboxEvents } from '@usrp/shared-database';
import type { Agency } from '@usrp/shared-types';
import type {
  AssignDeviceInput,
  AssignOutcome,
  ContactSource,
  DeviceRecord,
  DeviceRegistry,
  EnrollDeviceInput,
  EnrollOutcome,
  FleetDevice,
  RevokeDeviceInput,
  RevokeOutcome,
  RevokeReason,
} from '../ports/device-registry.js';
import { FieldSyncPersistenceError } from '../domain/field-sync.errors.js';

const SYSTEM_ROLE = 'usrp_system_service';

/** This service's outbox rows; its relay drains only these. */
export const FIELD_SYNC_OUTBOX_PRODUCER = 'field-sync-service';

interface DeviceRow {
  readonly device_id: string;
  readonly public_key_pem: string;
  readonly agency: Agency;
  readonly revoked_at: Date | null;
}

interface FleetRow {
  readonly device_id: string;
  readonly enrolled_by: string;
  readonly enrolled_at: Date | string;
  readonly last_seen_at: Date | string | null;
  readonly last_seen_source: ContactSource | null;
  readonly last_sync_at: Date | string | null;
  readonly revoked_at: Date | string | null;
  readonly revoke_reason: RevokeReason | null;
  readonly a_district: string | null;
  readonly a_exam_date: string | null;
  readonly a_campaign: string | null;
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
        const existing = await tx<{ agency: Agency; revoked_at: Date | null }[]>`
          SELECT agency, revoked_at FROM public_core.field_devices WHERE device_id = ${input.deviceId}
        `;
        const row = existing[0];
        if (!row) throw new FieldSyncPersistenceError('Device vanished during enrollment');
        // A revoked id is never revived (and never reported as enrolled).
        if (row.revoked_at !== null) return { kind: 'REVOKED' };
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
  async list(scope: { readonly agency: Agency; readonly dbRole: string }): Promise<readonly FleetDevice[]> {
    try {
      return await sql.begin(async (tx): Promise<readonly FleetDevice[]> => {
        // The officer's OWN role: field_devices / assignments are FORCE'd-RLS by agency.
        await tx`SET LOCAL ROLE ${sql(scope.dbRole)}`;
        const rows = await tx<FleetRow[]>`
          SELECT d.device_id, d.enrolled_by, d.enrolled_at, d.last_seen_at, d.last_seen_source,
                 d.last_sync_at, d.revoked_at, d.revoke_reason,
                 a.district AS a_district, a.exam_date::text AS a_exam_date, c.public_code AS a_campaign
          FROM public_core.field_devices d
          LEFT JOIN LATERAL (
            SELECT x.district, x.exam_date, x.campaign_id
            FROM public_core.field_device_assignments x
            WHERE x.device_id = d.device_id
            ORDER BY x.exam_date DESC LIMIT 1
          ) a ON true
          LEFT JOIN public_core.recruitment_campaigns c ON c.id = a.campaign_id
          WHERE d.agency = ${scope.agency}::public_core.agency
          ORDER BY d.enrolled_at DESC, d.device_id ASC
          LIMIT 500
        `;
        return rows.map((r): FleetDevice => ({
          deviceId: r.device_id,
          enrolledBy: r.enrolled_by,
          enrolledAt: new Date(r.enrolled_at).toISOString(),
          lastSeenAt: r.last_seen_at === null ? null : new Date(r.last_seen_at).toISOString(),
          lastSeenSource: r.last_seen_source,
          lastSyncAt: r.last_sync_at === null ? null : new Date(r.last_sync_at).toISOString(),
          revokedAt: r.revoked_at === null ? null : new Date(r.revoked_at).toISOString(),
          revokeReason: r.revoke_reason,
          assignment:
            r.a_district === null || r.a_exam_date === null || r.a_campaign === null
              ? null
              : { campaignPublicCode: r.a_campaign, district: r.a_district, examDate: r.a_exam_date },
        }));
      });
    } catch (cause) {
      throw new FieldSyncPersistenceError('Failed to list devices', { cause });
    }
  }

  async revoke(input: RevokeDeviceInput): Promise<RevokeOutcome> {
    try {
      return await sql.begin(async (tx): Promise<RevokeOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        // Agency in the predicate: a sibling agency's device is indistinguishable from none.
        const updated = await tx<{ device_id: string }[]>`
          UPDATE public_core.field_devices
             SET revoked_at = now(), revoked_by = ${input.revokedBy}, revoke_reason = ${input.reason}
           WHERE device_id = ${input.deviceId}
             AND agency = ${input.agency}::public_core.agency
             AND revoked_at IS NULL
          RETURNING device_id
        `;
        if (updated[0]) {
          await stageOutboxEvents(tx, [input.audit], FIELD_SYNC_OUTBOX_PRODUCER);
          return { kind: 'REVOKED' };
        }
        const existing = await tx<{ device_id: string }[]>`
          SELECT device_id FROM public_core.field_devices
          WHERE device_id = ${input.deviceId} AND agency = ${input.agency}::public_core.agency
        `;
        return existing[0] ? { kind: 'ALREADY_REVOKED' } : { kind: 'NOT_FOUND' };
      });
    } catch (cause) {
      throw new FieldSyncPersistenceError('Failed to revoke device', { cause });
    }
  }

  async assign(input: AssignDeviceInput): Promise<AssignOutcome> {
    try {
      return await sql.begin(async (tx): Promise<AssignOutcome> => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        const device = await tx<{ revoked_at: Date | null }[]>`
          SELECT revoked_at FROM public_core.field_devices
          WHERE device_id = ${input.deviceId} AND agency = ${input.agency}::public_core.agency
          FOR SHARE
        `;
        const d = device[0];
        if (!d) return { kind: 'DEVICE_NOT_FOUND' };
        if (d.revoked_at !== null) return { kind: 'DEVICE_REVOKED' };
        // The venue day must exist in THIS agency's campaign.
        const venues = await tx<{ campaign_id: string }[]>`
          SELECT c.id AS campaign_id
          FROM public_core.recruitment_campaigns c
          JOIN public_core.campaign_venue_assignments v ON v.campaign_id = c.id
          WHERE c.public_code = ${input.campaignPublicCode}
            AND c.agency = ${input.agency}::public_core.agency
            AND v.district = ${input.district}
            AND v.exam_date = ${input.examDate}
          LIMIT 1
        `;
        const venue = venues[0];
        if (!venue) return { kind: 'VENUE_NOT_FOUND' };
        // One venue per device per day; assigning again moves it (idempotent for the same venue).
        await tx`
          INSERT INTO public_core.field_device_assignments
            (device_id, exam_date, agency, campaign_id, district, assigned_by)
          VALUES (${input.deviceId}, ${input.examDate}::date, ${input.agency}::public_core.agency,
                  ${venue.campaign_id}, ${input.district}, ${input.assignedBy})
          ON CONFLICT (device_id, exam_date) DO UPDATE
            SET campaign_id = EXCLUDED.campaign_id, district = EXCLUDED.district,
                assigned_by = EXCLUDED.assigned_by, assigned_at = now()
        `;
        await stageOutboxEvents(tx, [input.audit], FIELD_SYNC_OUTBOX_PRODUCER);
        return { kind: 'ASSIGNED' };
      });
    } catch (cause) {
      throw new FieldSyncPersistenceError('Failed to assign device', { cause });
    }
  }

  async touch(deviceId: string, source: ContactSource): Promise<void> {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(SYSTEM_ROLE)}`;
        await tx`SELECT public_core.touch_field_device(${deviceId}, ${source})`;
      });
    } catch (cause) {
      throw new FieldSyncPersistenceError('Failed to stamp device contact', { cause });
    }
  }
}
