// BUILD-001 campaign boundary. Writes use the officer's verified session JWT,
// a required typed Idempotency-Key, and fresh allowlisted request objects.
// Public reads project only safe, externally published campaign fields.

import { HttpError, type RouteHandler } from '@usrp/shared-http';
import { UPSTREAM, type UpstreamOperation } from '../../domain/upstream-operations.js';
import { withAnonymous, withOfficerSession, type EdgeDeps } from './guards.js';
import { readJsonBody } from './validation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,63}$/;
const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';
const PUBLIC_STATUSES = new Set(['REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'COMPLETED', 'CANCELLED']);
const PUBLIC_FIELDS = [
  'publicCode',
  'campaignLabel',
  'agency',
  'status',
  'registrationOpensAt',
  'registrationClosesAt',
  'examinationStartDate',
  'examinationEndDate',
  'targetCategories',
  'targetDistricts',
  'allowsWalkIn',
  'contactPhoneNumbers',
  'contactWebsite',
] as const;

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  return value.length === 1 ? value[0] : undefined;
}

function requireIdempotencyKey(value: string | readonly string[] | undefined): string {
  const raw = headerValue(value)?.trim();
  if (raw === undefined || !UUID_RE.test(raw)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'A UUID Idempotency-Key header is required.');
  }
  return raw.toLowerCase();
}

function exactKeys(
  body: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new HttpError(400, 'INVALID_REQUEST', `Field "${key}" is not accepted.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(body, key)) throw new HttpError(400, 'INVALID_REQUEST', `Field "${key}" is required.`);
  }
}

function requirePublicCode(value: unknown, allowLegacy = false): string {
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_PUBLIC_CODE', 'Field "publicCode" is required.');
  const code = value.trim().toUpperCase();
  const legacyCode = /^LEGACY-[A-F0-9]{32}$/.test(code);
  if (!PUBLIC_CODE_RE.test(code) ||
      (code.startsWith('LEGACY-') && (!allowLegacy || !legacyCode))) {
    throw new HttpError(400, 'INVALID_PUBLIC_CODE', 'Field "publicCode" is invalid.');
  }
  return code;
}

function requestObject(
  body: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  allowLegacyPublicCode = false,
): Record<string, unknown> {
  exactKeys(body, required, optional);
  const result: Record<string, unknown> = {};
  for (const key of required) result[key] = body[key];
  for (const key of optional) {
    if (Object.hasOwn(body, key)) result[key] = body[key];
  }
  if (Object.hasOwn(result, 'publicCode')) {
    result['publicCode'] = requirePublicCode(result['publicCode'], allowLegacyPublicCode);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicCampaign(value: unknown, listOnly: boolean): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const status = value['status'];
  if (typeof status !== 'string' || !PUBLIC_STATUSES.has(status) || (listOnly && status !== 'REGISTRATION_OPEN')) {
    return null;
  }
  const projection: Record<string, unknown> = {};
  for (const field of PUBLIC_FIELDS) {
    if (!Object.hasOwn(value, field)) return null;
    projection[field] = value[field];
  }
  if (
    typeof projection['publicCode'] !== 'string' ||
    typeof projection['campaignLabel'] !== 'string' ||
    typeof projection['agency'] !== 'string' ||
    typeof projection['registrationOpensAt'] !== 'string' ||
    typeof projection['registrationClosesAt'] !== 'string' ||
    typeof projection['examinationStartDate'] !== 'string' ||
    typeof projection['examinationEndDate'] !== 'string' ||
    typeof projection['allowsWalkIn'] !== 'boolean' ||
    !Array.isArray(projection['targetCategories']) ||
    !Array.isArray(projection['targetDistricts']) ||
    (projection['contactPhoneNumbers'] !== null && !Array.isArray(projection['contactPhoneNumbers'])) ||
    (projection['contactWebsite'] !== null && typeof projection['contactWebsite'] !== 'string')
  ) return null;
  // ADR-049: the detail read also carries the per-category rules a citizen may read; rebuilt from an allowlist.
  if (!listOnly) projection['eligibility'] = projectEligibility(value['eligibility']);
  return projection;
}

const QUALIFICATION_RE = /^(FIELD:)?[A-Z][A-Z0-9_]{1,40}$/;

/** PURE. Per category: age bands, accepted levels and the science bar; anything else is dropped. */
export function projectEligibility(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(value)) return out;
  for (const [category, raw] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]{2,40}$/.test(category) || !isRecord(raw)) continue;
    const bands = raw['ageBands'];
    const alternatives = raw['educationAlternatives'];
    if (!Array.isArray(bands) || !Array.isArray(alternatives)) continue;
    const ageBands = bands.flatMap((b: unknown) =>
      isRecord(b) && Array.isArray(b['qualifications']) && b['qualifications'].every((q) => typeof q === 'string' && QUALIFICATION_RE.test(q)) &&
      Number.isInteger(b['minimumAge']) && Number.isInteger(b['maximumAge'])
        ? [{ qualifications: b['qualifications'], minimumAge: b['minimumAge'], maximumAge: b['maximumAge'] }]
        : []);
    if (ageBands.length === 0) continue;
    const educationAlternatives = alternatives.flatMap((a: unknown) => (isRecord(a) && typeof a['level'] === 'string' && QUALIFICATION_RE.test(a['level']) ? [{ level: a['level'] }] : []));
    const science = raw['minimumSciencePercent'];
    out[category] = { ageBands, educationAlternatives, minimumSciencePercent: Number.isInteger(science) ? science : null };
  }
  return out;
}

function publicReadBody(value: unknown, listOnly: boolean): unknown {
  if (!isRecord(value)) throw new HttpError(502, 'UPSTREAM_CONTRACT_MISMATCH');
  if (listOnly) {
    const campaigns = value['campaigns'];
    if (!Array.isArray(campaigns)) throw new HttpError(502, 'UPSTREAM_CONTRACT_MISMATCH');
    const projected = campaigns.map((campaign) => publicCampaign(campaign, true));
    if (projected.some((campaign) => campaign === null)) throw new HttpError(502, 'UPSTREAM_CONTRACT_MISMATCH');
    return { campaigns: projected };
  }
  const campaign = publicCampaign(value['campaign'], false);
  if (campaign === null) throw new HttpError(502, 'UPSTREAM_CONTRACT_MISMATCH');
  return { campaign };
}

function campaignWriteHandler(
  deps: EdgeDeps,
  operationId: Parameters<typeof withOfficerSession>[1],
  upstreamOperation: UpstreamOperation,
  allowedRequired: readonly string[],
  allowedOptional: readonly string[] = [],
  allowLegacyPublicCode = false,
): RouteHandler {
  return withOfficerSession(deps, operationId, async (ctx, session) => {
    const parsed = await readJsonBody(ctx);
    const body = requestObject(parsed, allowedRequired, allowedOptional, allowLegacyPublicCode);
    const idempotencyKey = requireIdempotencyKey(ctx.headers['idempotency-key']);
    const upstream = await deps.upstream.call({
      operation: upstreamOperation,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
      idempotencyKey,
      body,
    });
    if (upstream.status >= 200 && upstream.status < 300) {
      return {
        status: upstream.status,
        body: upstream.body,
        ...(upstream.replayed === true ? { headers: { [IDEMPOTENCY_REPLAYED_HEADER]: 'true' } } : {}),
      };
    }
    if (upstream.status === 401) return { status: 401, body: { reason: 'revoked' } };
    if (upstream.status === 404 || upstream.status === 409 || upstream.status === 422) {
      return { status: upstream.status, body: upstream.body };
    }
    if (upstream.status === 403) return { status: 403, body: { error: 'FORBIDDEN' } };
    if (upstream.status === 400) return { status: 400, body: { error: 'INVALID_REQUEST' } };
    return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
  });
}

export function createCampaignHandler(deps: EdgeDeps): RouteHandler {
  return campaignWriteHandler(
    deps,
    'createCampaign',
    UPSTREAM.campaignCreate,
    [
      'publicCode', 'campaignLabel', 'targetCategories', 'targetDistricts',
      'registrationOpensAt', 'registrationClosesAt', 'examinationStartDate',
      'examinationEndDate', 'examinationReportingHour', 'allowsWalkIn',
    ],
    ['targetIntakeCount', 'contactPhoneNumbers', 'contactWebsite'],
  );
}

export function createCampaignPolicyHandler(deps: EdgeDeps): RouteHandler {
  return campaignWriteHandler(
    deps,
    'createCampaignPolicy',
    UPSTREAM.campaignPolicy,
    ['publicCode', 'policyDocument', 'legalBasisCode', 'legalBasisReference'],
  );
}

export function configureCampaignSessionHandler(deps: EdgeDeps): RouteHandler {
  return campaignWriteHandler(
    deps,
    'configureCampaignSession',
    UPSTREAM.campaignSession,
    [
      'publicCode', 'district', 'province', 'venueName', 'examDate',
      'reportingTimeHour', 'capacityLimit', 'isActive',
    ],
    ['capacityDecisionCode'],
  );
}

export function publishCampaignHandler(deps: EdgeDeps): RouteHandler {
  return campaignWriteHandler(deps, 'publishCampaign', UPSTREAM.campaignPublish, ['publicCode']);
}

export function closeCampaignRegistrationHandler(deps: EdgeDeps): RouteHandler {
  return campaignWriteHandler(
    deps,
    'closeCampaignRegistration',
    UPSTREAM.campaignRegistrationClose,
    ['publicCode'],
  );
}

export function completeCampaignHandler(deps: EdgeDeps): RouteHandler {
  return campaignWriteHandler(
    deps,
    'completeCampaign',
    UPSTREAM.campaignComplete,
    ['publicCode'],
    [],
    true,
  );
}

export function cancelCampaignHandler(deps: EdgeDeps): RouteHandler {
  return campaignWriteHandler(deps, 'cancelCampaign', UPSTREAM.campaignCancel, ['publicCode']);
}

export function listPublicCampaignsHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'listCampaigns', async (ctx) => {
    if (ctx.query.toString().length !== 0) throw new HttpError(400, 'INVALID_QUERY');
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.publicCampaignList,
      correlationId: ctx.correlationId,
    });
    if (upstream.status !== 200) {
      if (upstream.status === 404) return { status: 404, body: { error: 'NOT_FOUND' } };
      return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    }
    return { status: 200, body: publicReadBody(upstream.body, true) };
  });
}

export function publicCampaignDetailHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'getCampaignDetail', async (ctx) => {
    const codes = ctx.query.getAll('publicCode');
    if (codes.length !== 1) throw new HttpError(400, 'INVALID_PUBLIC_CODE');
    const publicCode = requirePublicCode(codes[0]);
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.publicCampaignDetail,
      correlationId: ctx.correlationId,
      query: { publicCode },
    });
    if (upstream.status === 404) return { status: 404, body: { error: 'CAMPAIGN_NOT_FOUND' } };
    if (upstream.status !== 200) return { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
    return { status: 200, body: publicReadBody(upstream.body, false) };
  });
}
