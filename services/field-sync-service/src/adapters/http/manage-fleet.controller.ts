// ══════════════════════════════════════════════════════════════════
// field-sync-service — Fleet HTTP ingress (S09)
//
//   GET  /v1/field-sync/devices/fleet   list the agency's devices   field.device.manage
//   POST /v1/field-sync/devices/assign  bind a device to a venue day field.device.manage
//   POST /v1/field-sync/devices/revoke  revoke (reason required)    field.device.manage
//
// (The list lives under /fleet because GET/POST on /devices is the enrolment
// route, owned by field.device.enroll.) Agency from the token only. A device of
// another agency and a device that does not exist are the same bare 404.
// ══════════════════════════════════════════════════════════════════

import { HttpError, type HttpResult, type Route } from '@usrp/shared-http';
import { dbRoleForPrincipal, requireOfficerPermission, withAuth, type AuthVerifier } from '@usrp/shared-auth';
import type { FleetActor, ManageFleetService } from '../../application/manage-fleet.service.js';
import { REVOKE_REASONS, type RevokeReason } from '../../ports/device-registry.js';

export const LIST_FLEET_PATH = '/v1/field-sync/devices/fleet';
export const ASSIGN_DEVICE_PATH = '/v1/field-sync/devices/assign';
export const REVOKE_DEVICE_PATH = '/v1/field-sync/devices/revoke';

const NOT_FOUND: HttpResult = { status: 404, body: { error: 'NOT_FOUND' } };
const PUBLIC_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,63}$/;
const DISTRICT_RE = /^[A-Z][A-Z_]{1,29}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'INVALID_FIELD', `Field "${field}" is required.`);
  }
  if (value.length > maxLen) throw new HttpError(400, 'INVALID_FIELD', `Field "${field}" is too long.`);
  return value;
}

function patterned(value: unknown, field: string, re: RegExp, upper: boolean): string {
  const v = upper ? str(value, field, 64).toUpperCase() : str(value, field, 64);
  if (!re.test(v)) throw new HttpError(400, 'INVALID_FIELD', `Field "${field}" is invalid.`);
  return v;
}

function calendarDay(value: unknown, field: string): string {
  const v = patterned(value, field, DAY_RE, false);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, 'INVALID_FIELD', `Field "${field}" is not a calendar date.`);
  }
  return v;
}

function actorOf(principal: Parameters<typeof dbRoleForPrincipal>[0]): FleetActor {
  if (principal.kind !== 'officer') throw new HttpError(403, 'FORBIDDEN', 'Officer principal required.');
  return { agency: principal.agency, subjectId: principal.subjectId, dbRole: dbRoleForPrincipal(principal) };
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new HttpError(400, 'INVALID_FIELD', `Field "${key}" is not accepted.`);
  }
}

export function manageFleetRoutes(service: ManageFleetService, verify: AuthVerifier): Route[] {
  return [
    {
      method: 'GET',
      path: LIST_FLEET_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (_ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'field.device.manage');
        const devices = await service.list(actorOf(principal));
        return { status: 200, body: { devices } };
      }),
    },
    {
      method: 'POST',
      path: ASSIGN_DEVICE_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'field.device.manage');
        const body = await ctx.json<Record<string, unknown>>();
        rejectUnknownKeys(body, ['deviceId', 'campaign', 'district', 'examDate']);
        const outcome = await service.assign(actorOf(principal), {
          deviceId: str(body['deviceId'], 'deviceId', 64),
          campaignPublicCode: patterned(body['campaign'], 'campaign', PUBLIC_CODE_RE, true),
          district: patterned(body['district'], 'district', DISTRICT_RE, true),
          examDate: calendarDay(body['examDate'], 'examDate'),
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
        switch (outcome.kind) {
          case 'ASSIGNED':
            return { status: 200, body: { status: 'ASSIGNED' } };
          case 'DEVICE_REVOKED':
            return { status: 409, body: { error: 'DEVICE_REVOKED' } };
          case 'DEVICE_NOT_FOUND':
          case 'VENUE_NOT_FOUND':
            return NOT_FOUND;
        }
      }),
    },
    {
      method: 'POST',
      path: REVOKE_DEVICE_PATH,
      handler: withAuth(verify, { kind: 'officer' }, async (ctx, principal): Promise<HttpResult> => {
        requireOfficerPermission(principal, 'field.device.manage');
        const body = await ctx.json<Record<string, unknown>>();
        rejectUnknownKeys(body, ['deviceId', 'reason']);
        const reason = str(body['reason'], 'reason', 24);
        if (!(REVOKE_REASONS as readonly string[]).includes(reason)) {
          throw new HttpError(400, 'INVALID_FIELD', 'Field "reason" is not an accepted reason code.');
        }
        const outcome = await service.revoke(actorOf(principal), {
          deviceId: str(body['deviceId'], 'deviceId', 64),
          reason: reason as RevokeReason,
          context: { correlationId: ctx.correlationId, causationId: ctx.correlationId },
        });
        if (outcome.kind === 'NOT_FOUND') return NOT_FOUND;
        return { status: 200, body: { status: outcome.kind } };
      }),
    },
  ];
}
