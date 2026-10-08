// Structural validation for the scheduling-owned BUILD-001 session command.
// Campaign ownership/target membership/window checks are repeated under the
// campaign row lock by the PostgreSQL adapter.

import {
  DISTRICTS,
  DISTRICT_TO_PROVINCE,
  PROVINCES,
  type CampaignSessionInput,
  type District,
  type Province,
} from '@usrp/shared-types';

const PUBLIC_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,63}$/;

export class CampaignSessionInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CampaignSessionInputError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new CampaignSessionInputError(code, message);
}

function exactKeys(body: Record<string, unknown>): void {
  const expected = new Set([
    'publicCode',
    'district',
    'province',
    'venueName',
    'examDate',
    'reportingTimeHour',
    'capacityLimit',
    'isActive',
  ]);
  for (const key of Object.keys(body)) {
    if (!expected.has(key)) fail('INVALID_REQUEST', `Field "${key}" is not accepted.`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(body, key)) fail('INVALID_REQUEST', `Field "${key}" is required.`);
  }
}

function publicCode(value: unknown): string {
  if (typeof value !== 'string') fail('INVALID_PUBLIC_CODE', 'Field "publicCode" is required.');
  const normalized = value.trim().toUpperCase();
  if (!PUBLIC_CODE_RE.test(normalized) || normalized.startsWith('LEGACY-')) {
    fail('INVALID_PUBLIC_CODE', 'Field "publicCode" is invalid.');
  }
  return normalized;
}

function calendarDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail('INVALID_DATE', 'Field "examDate" must be YYYY-MM-DD.');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('INVALID_DATE', 'Field "examDate" must be a real calendar date.');
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_REQUEST', `Field "${name}" must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

export function normalizeCampaignSession(value: unknown): CampaignSessionInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_REQUEST', 'Request body must be an object.');
  }
  const body = value as Record<string, unknown>;
  exactKeys(body);
  if (typeof body.district !== 'string' || !DISTRICTS.includes(body.district as District)) {
    fail('INVALID_DISTRICT', 'Field "district" must be a recognized district.');
  }
  if (typeof body.province !== 'string' || !PROVINCES.includes(body.province as Province)) {
    fail('INVALID_PROVINCE', 'Field "province" must be a recognized province.');
  }
  const district = body.district as District;
  const province = body.province as Province;
  if (DISTRICT_TO_PROVINCE[district] !== province) {
    fail('DISTRICT_PROVINCE_MISMATCH', 'The supplied province does not own the selected district.');
  }
  if (typeof body.venueName !== 'string') fail('INVALID_REQUEST', 'Field "venueName" must be a string.');
  const venueName = body.venueName.trim().normalize('NFC');
  if (venueName.length === 0 || venueName.length > 200 || hasControlCharacters(venueName)) {
    fail('INVALID_REQUEST', 'Field "venueName" must contain 1..200 printable characters.');
  }
  let capacityLimit: number | null;
  if (body.capacityLimit === null) {
    capacityLimit = null;
  } else {
    capacityLimit = integer(body.capacityLimit, 'capacityLimit', 1, 2_147_483_647);
  }
  if (typeof body.isActive !== 'boolean') fail('INVALID_REQUEST', 'Field "isActive" must be a boolean.');
  return {
    publicCode: publicCode(body.publicCode),
    district,
    province,
    venueName,
    examDate: calendarDate(body.examDate),
    reportingTimeHour: integer(body.reportingTimeHour, 'reportingTimeHour', 0, 23),
    capacityLimit,
    isActive: body.isActive,
  };
}
