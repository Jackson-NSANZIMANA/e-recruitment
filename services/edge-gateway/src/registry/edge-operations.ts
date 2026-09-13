// ══════════════════════════════════════════════════════════════════
// edge-gateway — The EDGE OPERATION REGISTRY
//
// The single declaration of the browser boundary: 26 operations, each naming
// its exact path, method, required session kind, CSRF obligation, body cap,
// retry disposition and the approved upstream operation(s) it fronts.
//
// DATA ONLY — no handlers, no imports from the adapter layer. That is what
// lets selfcheck/verify-edge-contract.ts assert the whole boundary without
// booting a process, opening a socket, or touching Postgres.
//
// Route composition in src/routes.ts is keyed by `Record<EdgeOperationId, …>`,
// so adding an operation here and forgetting its handler is a TYPE ERROR, not
// a 404 discovered in production.
//
// THREE THINGS ARE DELIBERATELY NOT EXPRESSIBLE HERE:
//
//   • An agency. No path segment, query parameter or body field in this file
//     carries one. It is read from the verified officer session, which makes it
//     server-authoritative by construction rather than by validation.
//   • A path parameter. shared-http matches paths EXACTLY (ADR-005); a client
//     that builds `/applications/{id}` type-checks and 404s for every input.
//   • PATCH or DELETE. Transitions are separate typed POSTs with separate
//     authority. A generic status write is a broken authorization model.
// ══════════════════════════════════════════════════════════════════

import { UPSTREAM, type UpstreamOperation, type UpstreamOperationId } from './upstream-operations.js';

/** Which session kind an operation admits. `anonymous` means "no session required". */
export type SessionRequirement = 'anonymous' | 'officer' | 'applicant';

export interface EdgeOperation {
  readonly operationId: string;
  readonly method: 'GET' | 'POST';
  /** Exact path. Always under /edge/v1/. */
  readonly path: string;
  readonly session: SessionRequirement;
  /**
   * Whether `x-csrf-token` is validated. TRUE for every unsafe method,
   * including the anonymous ones: login and OTP are exactly the requests a
   * cross-site page would most like to forge on a victim's behalf.
   */
  readonly csrf: boolean;
  /** Per-route body cap. Raised only where a batch genuinely needs it. */
  readonly maxBodyBytes: number;
  /**
   * Whether the FRONTEND may retry this operation on a 503. False for every
   * state-changing write: a retried transition is a double write on a citizen's
   * legal record. The edge itself retries NOTHING, ever (see upstream-client).
   */
  readonly retryOnG2G: boolean;
  /** Reachable without a session by design. Four such operations exist. */
  readonly publicAllowlist: boolean;
  /** The approved upstream operation(s). `readSession` fronts none. */
  readonly upstream: readonly UpstreamOperation[];
  /**
   * `single`   exactly one upstream operation — the normal case.
   * `composed` more than one, with the reason stated. Declared so the contract
   *            test can hold every other operation to one-to-one.
   * `local`    served entirely by the edge's own session store.
   */
  readonly composition: 'single' | 'composed' | 'local';
  readonly compositionReason?: string;
}

const KIB = 1_024;
/** Default cap. Deliberately small: no browser operation here posts documents. */
const SMALL_BODY = 8 * KIB;
/**
 * The offline score batch. A tablet reconnecting after a day at an exam venue
 * uploads many signed records at once, so this ONE route is raised — and only
 * this one. Lifting the service-wide default to suit it would hand every other
 * route the same large-payload budget. The record COUNT is capped separately in
 * the controller, because bytes alone do not bound signature-verification work.
 */
const FIELD_SYNC_BATCH_BODY = 512 * KIB;

export const EDGE_OPERATIONS = Object.freeze({
  // ── Session ────────────────────────────────────────────────
  readSession: {
    operationId: 'readSession',
    method: 'GET',
    path: '/edge/v1/session',
    session: 'anonymous',
    csrf: false,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: true,
    upstream: [],
    composition: 'local',
  },
  refreshSession: {
    operationId: 'refreshSession',
    method: 'POST',
    path: '/edge/v1/session/refresh',
    session: 'anonymous',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: true,
    upstream: [],
    composition: 'local',
  },

  // ── Officer auth ───────────────────────────────────────────
  officerLogin: {
    operationId: 'officerLogin',
    method: 'POST',
    path: '/edge/v1/auth/officer/login',
    session: 'anonymous',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: true,
    upstream: [UPSTREAM.officerLogin],
    composition: 'single',
  },
  officerLogout: {
    operationId: 'officerLogout',
    method: 'POST',
    path: '/edge/v1/auth/officer/logout',
    session: 'officer',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    // No upstream call: an Ed25519 officer JWT is NOT revocable (ADR-016).
    // Destroying the edge handle is the only revocation that exists, which is
    // why logout must be a server-side destroy and not a cookie clear.
    upstream: [],
    composition: 'local',
  },

  // ── Applicant auth ─────────────────────────────────────────
  requestApplicantOtp: {
    operationId: 'requestApplicantOtp',
    method: 'POST',
    path: '/edge/v1/auth/applicant/otp/request',
    session: 'anonymous',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: true,
    publicAllowlist: true,
    upstream: [UPSTREAM.otpRequest],
    composition: 'single',
  },
  verifyApplicantOtp: {
    operationId: 'verifyApplicantOtp',
    method: 'POST',
    path: '/edge/v1/auth/applicant/otp/verify',
    session: 'anonymous',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: true,
    upstream: [UPSTREAM.otpVerify],
    composition: 'single',
  },
  logoutApplicant: {
    operationId: 'logoutApplicant',
    method: 'POST',
    path: '/edge/v1/auth/applicant/logout',
    session: 'applicant',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    // The citizen token IS revocable (ADR-018) — revoke it upstream AND destroy
    // the handle. Clearing only the cookie would waste the property ADR-018 was
    // chosen for.
    upstream: [UPSTREAM.applicantLogout],
    composition: 'single',
  },

  // ── Officer reads — agency from the session, never the request ──
  listApplications: {
    operationId: 'listApplications',
    method: 'GET',
    path: '/edge/v1/applications',
    session: 'officer',
    csrf: false,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: true,
    publicAllowlist: false,
    upstream: [UPSTREAM.listApplications],
    composition: 'single',
  },
  listAmberQueue: {
    operationId: 'listAmberQueue',
    method: 'GET',
    path: '/edge/v1/applications/amber-queue',
    session: 'officer',
    csrf: false,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: true,
    publicAllowlist: false,
    upstream: [UPSTREAM.amberQueue],
    composition: 'single',
  },
  findApplicationById: {
    operationId: 'findApplicationById',
    method: 'GET',
    path: '/edge/v1/applications/by-id',
    session: 'officer',
    csrf: false,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: true,
    publicAllowlist: false,
    upstream: [UPSTREAM.applicationById],
    composition: 'single',
  },
  getApplicationDetail: {
    operationId: 'getApplicationDetail',
    method: 'GET',
    path: '/edge/v1/applications/detail',
    session: 'officer',
    csrf: false,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: true,
    publicAllowlist: false,
    upstream: [UPSTREAM.applicationById, UPSTREAM.statusHistory],
    composition: 'composed',
    compositionReason:
      'The Procedural Justice view renders the record and the decision trail together. ' +
      'Composing here makes it ONE round trip from a field tablet on a slow link, and ' +
      'both upstream reads are already agency-scoped through the same officer DB role, ' +
      'so composition cannot widen either one.',
  },
  getApplicationStatusHistory: {
    operationId: 'getApplicationStatusHistory',
    method: 'GET',
    path: '/edge/v1/applications/status-history',
    session: 'officer',
    csrf: false,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: true,
    publicAllowlist: false,
    upstream: [UPSTREAM.statusHistory],
    composition: 'single',
  },

  // ── The FOUR transitions. Separate authority, separate routes. ──
  recordMedicalReview: {
    operationId: 'recordMedicalReview',
    method: 'POST',
    path: '/edge/v1/applications/medical-review',
    session: 'officer',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.medicalReview],
    composition: 'single',
  },
  recordFinalDecision: {
    operationId: 'recordFinalDecision',
    method: 'POST',
    path: '/edge/v1/applications/final-decision',
    session: 'officer',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.finalDecision],
    composition: 'single',
  },
  acceptApplication: {
    operationId: 'acceptApplication',
    method: 'POST',
    path: '/edge/v1/applications/accept',
    session: 'officer',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.accept],
    composition: 'single',
  },
  adjudicateApplication: {
    operationId: 'adjudicateApplication',
    method: 'POST',
    path: '/edge/v1/applications/adjudicate',
    session: 'officer',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.adjudicate],
    composition: 'single',
  },

  // ── Walk-in (RDF-only upstream; 501 for RNP/RCS is mapped to 403) ──
  registerWalkIn: {
    operationId: 'registerWalkIn',
    method: 'POST',
    path: '/edge/v1/applications/walk-in/register',
    session: 'officer',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.walkInRegister],
    composition: 'single',
  },
  vetWalkIn: {
    operationId: 'vetWalkIn',
    method: 'POST',
    path: '/edge/v1/applications/walk-in/vet',
    session: 'officer',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.walkInVet],
    composition: 'single',
  },

  // ── Identity verification — the ONE brokered service-internal route ──
  verifyIdentity: {
    operationId: 'verifyIdentity',
    method: 'POST',
    path: '/edge/v1/identities/verify',
    session: 'officer',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    // A NIDA lookup is a read whose only failure mode is "the registry is down".
    // The frontend may retry it; nothing is written by it.
    retryOnG2G: true,
    publicAllowlist: false,
    upstream: [UPSTREAM.verifyIdentity],
    composition: 'single',
  },

  // ── Citizen self-service — cross-agency by construction ──
  listMyApplications: {
    operationId: 'listMyApplications',
    method: 'GET',
    path: '/edge/v1/me/applications',
    session: 'applicant',
    csrf: false,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: true,
    publicAllowlist: false,
    upstream: [UPSTREAM.myApplications],
    composition: 'single',
  },
  withdrawMyApplication: {
    operationId: 'withdrawMyApplication',
    method: 'POST',
    path: '/edge/v1/me/applications/withdraw',
    session: 'applicant',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.myWithdraw],
    composition: 'single',
  },
  getMyErasureRequest: {
    operationId: 'getMyErasureRequest',
    method: 'GET',
    path: '/edge/v1/me/erasure-request',
    session: 'applicant',
    csrf: false,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: true,
    publicAllowlist: false,
    upstream: [UPSTREAM.myErasureRequestGet],
    composition: 'single',
  },
  fileMyErasureRequest: {
    operationId: 'fileMyErasureRequest',
    method: 'POST',
    // Same exact path as the GET above, different method. shared-http keys its
    // table (path -> method -> handler), so two methods on one path is legal.
    path: '/edge/v1/me/erasure-request',
    session: 'applicant',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.myErasureRequestFile],
    composition: 'single',
  },

  // ── Field sync (NEW browser surface — see the reconciliation record) ──
  // The three upstream controllers were implemented and had no browser route,
  // which is why the frontend keeps OFFLINE_CAPTURE_CAN_SYNC = false. These
  // broker them: officer session only, agency from the session, CSRF enforced,
  // and NOTHING automatically retried — a re-uploaded batch converges because
  // sync-scores reports per-record outcomes, not because the edge retries it.
  enrollFieldDevice: {
    operationId: 'enrollFieldDevice',
    method: 'POST',
    path: '/edge/v1/field-sync/devices',
    session: 'officer',
    csrf: true,
    // A PEM public key is the largest field. 8 KiB is ample; the controller
    // caps publicKeyPem at 4096 characters.
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.enrollDevice],
    composition: 'single',
  },
  syncFieldScores: {
    operationId: 'syncFieldScores',
    method: 'POST',
    path: '/edge/v1/field-sync/scores',
    session: 'officer',
    csrf: true,
    maxBodyBytes: FIELD_SYNC_BATCH_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.syncScores],
    composition: 'single',
  },
  resolveFieldSyncConflict: {
    operationId: 'resolveFieldSyncConflict',
    method: 'POST',
    path: '/edge/v1/field-sync/conflicts/resolve',
    session: 'officer',
    csrf: true,
    maxBodyBytes: SMALL_BODY,
    retryOnG2G: false,
    publicAllowlist: false,
    upstream: [UPSTREAM.resolveConflict],
    composition: 'single',
  },
} as const satisfies Record<string, EdgeOperation>);

export type EdgeOperationId = keyof typeof EDGE_OPERATIONS;

export const EDGE_OPERATION_IDS: readonly EdgeOperationId[] = Object.freeze(
  Object.keys(EDGE_OPERATIONS) as EdgeOperationId[],
);

export function edgeOperation(id: EdgeOperationId): EdgeOperation {
  return EDGE_OPERATIONS[id];
}

/**
 * The public surface, derived rather than restated. A fifth entry appearing
 * here is a reviewable diff in the registry, and the contract selfcheck fails
 * if the count changes without the ADR being updated.
 */
export const PUBLIC_ALLOWLIST: readonly EdgeOperationId[] = Object.freeze(
  EDGE_OPERATION_IDS.filter((id) => EDGE_OPERATIONS[id].publicAllowlist),
);

/** Upstream ids reachable from the browser at all. Used by the contract test. */
export const REACHABLE_UPSTREAM_IDS: readonly UpstreamOperationId[] = Object.freeze(
  EDGE_OPERATION_IDS.flatMap((id) =>
    EDGE_OPERATIONS[id].upstream.map((u) => u.id as UpstreamOperationId),
  ),
);
