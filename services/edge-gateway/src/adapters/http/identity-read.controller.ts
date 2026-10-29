// ══════════════════════════════════════════════════════════════════
// edge-gateway — the citizen's OWN verified identity (ADR-049, ADR-FE-019)
//
// Session-scoped; nothing to ask with. The response is rebuilt from an
// ALLOWLIST: a field that is not named below cannot leave, whatever the
// upstream sends. Photo, signature, parents' names and the National ID are
// never named, so they never cross. placeOfBirth and nationality are part of the
// contract but NULL: the platform does not retain them today (the wizard asks).
// ══════════════════════════════════════════════════════════════════

import type { HttpResult, RouteHandler } from '@usrp/shared-http';
import { UPSTREAM } from '../../domain/upstream-operations.js';
import { NOT_FOUND } from './outcomes.js';
import { withApplicantSession, type EdgeDeps } from './guards.js';
import { field } from './projections.js';

const MISMATCH: HttpResult = { status: 502, body: { error: 'UPSTREAM_CONTRACT_MISMATCH' } };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface EdgeMyIdentity {
  readonly fullName: string;
  readonly sex: 'MALE' | 'FEMALE';
  readonly dateOfBirth: string;
  readonly homeDistrict: string;
  readonly homeProvince: string;
  readonly placeOfBirth: null;
  readonly nationality: null;
}

/** PURE. null when the upstream body is not the contract (never a partial leak). */
export function projectMyIdentity(body: unknown): EdgeMyIdentity | null {
  const fullName = field(body, 'fullName');
  const sex = field(body, 'sex');
  const dateOfBirth = field(body, 'dateOfBirth');
  const homeDistrict = field(body, 'homeDistrict');
  const homeProvince = field(body, 'homeProvince');
  if (typeof fullName !== 'string' || fullName === '' || fullName.length > 200) return null;
  if (sex !== 'MALE' && sex !== 'FEMALE') return null;
  if (typeof dateOfBirth !== 'string' || !ISO_DATE.test(dateOfBirth)) return null;
  if (typeof homeDistrict !== 'string' || homeDistrict === '' || homeDistrict.length > 60) return null;
  if (typeof homeProvince !== 'string' || homeProvince === '' || homeProvince.length > 60) return null;
  return { fullName, sex, dateOfBirth, homeDistrict, homeProvince, placeOfBirth: null, nationality: null };
}

export function getMyIdentityHandler(deps: EdgeDeps): RouteHandler {
  return withApplicantSession(deps, 'getMyIdentity', async (ctx, session) => {
    const upstream = await deps.upstream.call({
      operation: UPSTREAM.myIdentity,
      correlationId: ctx.correlationId,
      credential: session.upstreamCredential,
    });
    if (upstream.status === 401) return { status: 401, body: { reason: 'revoked' } };
    if (upstream.status === 404) return NOT_FOUND;
    if (upstream.status !== 200) return MISMATCH;
    const view = projectMyIdentity(upstream.body);
    return view === null ? MISMATCH : { status: 200, body: view };
  });
}
