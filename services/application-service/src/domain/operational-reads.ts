// ══════════════════════════════════════════════════════════════════
// application-service — Operational read models (ADR-039), pure domain
//
// Query parsing and the opaque keyset cursor for the officer console's
// operational reads. PURE: no I/O, no clock. Every function either returns a
// validated value or throws ReadInputError, which the controller maps to a 400.
//
// THE AGENCY IS NEVER AN INPUT. Nothing here parses one; the services derive it
// from the verified principal.
//
// CURSOR. Keyset, not offset: a page boundary is the (sort key, id) of the last
// row served, so an insert between two page fetches can neither repeat nor skip
// a row. The sort key travels as a microsecond-precision UTC string (never a JS
// Date, which would truncate to milliseconds and re-serve a row). The cursor is
// opaque to the client and NOT a security control: a forged cursor can only move
// the position inside the caller's own agency-scoped, RLS-bound result.
// ══════════════════════════════════════════════════════════════════

import {
  APPLICATION_STATUSES,
  DISTRICTS,
  ALL_CATEGORIES,
  type ApplicationStatus,
  type CampaignStatus,
  type District,
} from '@usrp/shared-types';
import { CampaignInputError, normalizePublicCode } from './campaign-validation.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
/** A venue day is bounded by its capacity; this is a hard ceiling, never a page. */
export const MAX_ROSTER_ROWS = 2_000;

export class ReadInputError extends Error {
  override readonly name = 'ReadInputError';
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` */
const SORT_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface KeysetCursor {
  readonly sortKey: string;
  readonly id: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify({ k: cursor.sortKey, i: cursor.id }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): KeysetCursor {
  const invalid = new ReadInputError('INVALID_CURSOR', 'Query "cursor" is not a cursor this operation issued.');
  if (raw.length === 0 || raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  if (parsed === null || typeof parsed !== 'object') throw invalid;
  const { k, i } = parsed as { k?: unknown; i?: unknown };
  if (typeof k !== 'string' || !SORT_KEY_RE.test(k) || typeof i !== 'string' || !UUID_RE.test(i)) throw invalid;
  return { sortKey: k, id: i.toLowerCase() };
}

/** Repeatable `name=a&name=b` and comma lists `name=a,b` both accepted; order-stable, de-duplicated. */
function listParam(query: URLSearchParams, name: string): readonly string[] {
  const values = query.getAll(name).flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '');
  return [...new Set(values)];
}

function single(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  if (values.length === 0) return undefined;
  if (values.length > 1 || values[0] === undefined) {
    throw new ReadInputError(`INVALID_${name.toUpperCase()}`, `Query "${name}" may be given once.`);
  }
  const trimmed = values[0].trim();
  return trimmed === '' ? undefined : trimmed;
}

function pageSize(query: URLSearchParams): number {
  const raw = single(query, 'limit');
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  if (!/^\d{1,4}$/.test(raw)) throw new ReadInputError('INVALID_LIMIT', `Query "limit" must be 1..${String(MAX_PAGE_SIZE)}.`);
  const n = Number(raw);
  if (n < 1 || n > MAX_PAGE_SIZE) throw new ReadInputError('INVALID_LIMIT', `Query "limit" must be 1..${String(MAX_PAGE_SIZE)}.`);
  return n;
}

function cursorParam(query: URLSearchParams): KeysetCursor | null {
  const raw = single(query, 'cursor');
  return raw === undefined ? null : decodeCursor(raw);
}

function calendarDate(raw: string | undefined, name: string): string | null {
  if (raw === undefined) return null;
  if (!DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) || new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) {
    throw new ReadInputError(`INVALID_${name.toUpperCase()}`, `Query "${name}" must be a calendar date (YYYY-MM-DD).`);
  }
  return raw;
}

function publicCode(raw: string, name: string): string {
  try {
    return normalizePublicCode(raw, true);
  } catch (error) {
    if (error instanceof CampaignInputError) throw new ReadInputError(`INVALID_${name.toUpperCase()}`, `Query "${name}" is not a campaign public code.`);
    throw error;
  }
}

function districtParam(raw: string | undefined, name: string): District | null {
  if (raw === undefined) return null;
  const upper = raw.toUpperCase();
  if (!(DISTRICTS as readonly string[]).includes(upper)) throw new ReadInputError(`INVALID_${name.toUpperCase()}`, `Query "${name}" is not a district.`);
  return upper as District;
}

// ── listApplicationsV2 ─────────────────────────────────────────────
export interface ApplicationSearch {
  readonly statuses: readonly ApplicationStatus[];
  readonly category: string | null;
  readonly campaignPublicCode: string | null;
  readonly district: District | null;
  /** Inclusive Kigali calendar days. */
  readonly submittedFrom: string | null;
  readonly submittedTo: string | null;
  readonly limit: number;
  readonly cursor: KeysetCursor | null;
}

export function parseApplicationSearch(query: URLSearchParams): ApplicationSearch {
  const statuses = listParam(query, 'status').map((s) => {
    const upper = s.toUpperCase();
    if (!(APPLICATION_STATUSES as readonly string[]).includes(upper)) {
      throw new ReadInputError('INVALID_STATUS', 'Query "status" holds an unknown application status.');
    }
    return upper as ApplicationStatus;
  });
  if (statuses.length > APPLICATION_STATUSES.length) throw new ReadInputError('INVALID_STATUS', 'Too many statuses.');
  const rawCategory = single(query, 'category')?.toUpperCase();
  if (rawCategory !== undefined && !ALL_CATEGORIES.has(rawCategory)) {
    throw new ReadInputError('INVALID_CATEGORY', 'Query "category" is not an application category.');
  }
  const rawCampaign = single(query, 'campaign');
  const submittedFrom = calendarDate(single(query, 'submittedFrom'), 'submittedFrom');
  const submittedTo = calendarDate(single(query, 'submittedTo'), 'submittedTo');
  if (submittedFrom !== null && submittedTo !== null && submittedFrom > submittedTo) {
    throw new ReadInputError('INVALID_SUBMITTEDFROM', 'Query "submittedFrom" is after "submittedTo".');
  }
  return {
    statuses,
    category: rawCategory ?? null,
    campaignPublicCode: rawCampaign === undefined ? null : publicCode(rawCampaign, 'campaign'),
    district: districtParam(single(query, 'district'), 'district'),
    submittedFrom,
    submittedTo,
    limit: pageSize(query),
    cursor: cursorParam(query),
  };
}

// ── listAgencyCampaigns ────────────────────────────────────────────
export const CAMPAIGN_STATUS_VALUES: readonly CampaignStatus[] = [
  'DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'EXAMINATION_ACTIVE', 'COMPLETED', 'CANCELLED',
];

export interface CampaignAdminSearch {
  readonly statuses: readonly CampaignStatus[];
  /** Case-insensitive substring of the label or public code. */
  readonly text: string | null;
  readonly limit: number;
  readonly cursor: KeysetCursor | null;
}

export function parseCampaignAdminSearch(query: URLSearchParams): CampaignAdminSearch {
  const statuses = listParam(query, 'status').map((s) => {
    const upper = s.toUpperCase();
    if (!(CAMPAIGN_STATUS_VALUES as readonly string[]).includes(upper)) {
      throw new ReadInputError('INVALID_STATUS', 'Query "status" holds an unknown campaign status.');
    }
    return upper as CampaignStatus;
  });
  const text = single(query, 'q');
  if (text !== undefined && text.length > 64) throw new ReadInputError('INVALID_Q', 'Query "q" is at most 64 characters.');
  return { statuses, text: text ?? null, limit: pageSize(query), cursor: cursorParam(query) };
}

export function parseCampaignAdminDetail(query: URLSearchParams): string {
  const raw = single(query, 'publicCode');
  if (raw === undefined) throw new ReadInputError('INVALID_PUBLICCODE', 'Exactly one publicCode query parameter is required.');
  return publicCode(raw, 'publicCode');
}

// ── getVenueRoster ─────────────────────────────────────────────────
export interface RosterQuery {
  readonly campaignPublicCode: string;
  readonly district: District;
  readonly examDate: string;
}

export function parseRosterQuery(query: URLSearchParams): RosterQuery {
  const rawCampaign = single(query, 'campaign');
  const district = districtParam(single(query, 'district'), 'district');
  const examDate = calendarDate(single(query, 'examDate'), 'examDate');
  if (rawCampaign === undefined || district === null || examDate === null) {
    throw new ReadInputError('INVALID_ROSTER_QUERY', 'Queries "campaign", "district" and "examDate" are all required.');
  }
  return { campaignPublicCode: publicCode(rawCampaign, 'campaign'), district, examDate };
}

/** What a roster row may carry. Anything not named here cannot be emitted. */
export const ROSTER_ADMISSION_STATES = ['NOT_ADMITTED', 'ADMITTED'] as const;
export type RosterAdmissionState = (typeof ROSTER_ADMISSION_STATES)[number];
