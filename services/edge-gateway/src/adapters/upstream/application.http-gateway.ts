// ══════════════════════════════════════════════════════════════════
// edge-gateway — ApplicationGateway adapter (officer reads + writes)
//
// Every call carries the officer's own Ed25519 JWT, so upstream derives the
// agency from the VERIFIED token and runs the query under that agency's
// Postgres role. The edge never sends an agency and there is no parameter for
// one: that is what makes agency server-authoritative by construction rather
// than by validation, and it is why one edge replaces four per-agency BFFs.
//
// Reads are projected onto explicit row types (see ports/upstream.ts). The
// officer detail read is the one exception — it is forwarded as a record —
// because ApplicationDetail is the deliberate three-schema INTERSECTION and
// re-listing its 30 fields here would create a second place for the two
// security omissions (applicant_id, qr_invitation_code) to be re-added by hand.
// It is filtered by DENY-LIST instead, and the selfcheck asserts the deny-list.
// ══════════════════════════════════════════════════════════════════

import {
  ACCEPT_PATH,
  ADJUDICATE_PATH,
  AMBER_QUEUE_PATH,
  BY_ID_PATH,
  FINAL_DECISION_PATH,
  LIST_APPLICATIONS_PATH,
  MEDICAL_REVIEW_PATH,
  STATUS_HISTORY_PATH,
  WALK_IN_REGISTER_PATH,
  WALK_IN_VET_PATH,
} from '@usrp/application-service';
import { UpstreamCredentialRejected, UpstreamError } from '../../domain/errors.js';
import type {
  AmberQueueRow,
  ApplicationGateway,
  ApplicationListRow,
  MedicalVerdict,
  StatusHistoryRow,
  TransitionOutcome,
  UpstreamContext,
  WalkInRegisterOutcome,
  WalkInRegistration,
} from '../../ports/upstream.js';
import {
  asRecord,
  readArray,
  readNumber,
  readString,
  readUnknown,
  type UpstreamClient,
  type UpstreamResponse,
} from './http-json.js';
import { toTransitionOutcome } from './transition-outcome.js';

/**
 * Fields that must never reach a browser from the officer detail read.
 *
 * `applicant_id`/`applicantId` — the officer console identifies applicants by
 * their anonymous processing code; the opaque applicant key is still a "who".
 * `qrInvitationCode` — a BEARER CREDENTIAL the field officer scans at the
 * venue; returning it would publish an invitation token to every console
 * session able to open the record.
 *
 * The upstream port already omits both. This is the second lock: a future
 * per-agency read that legitimately widens the column set cannot silently
 * widen it to include these.
 */
const DETAIL_DENY_LIST: ReadonlySet<string> = new Set([
  'applicantId',
  'applicant_id',
  'qrInvitationCode',
  'qr_invitation_code',
]);

export class HttpApplicationGateway implements ApplicationGateway {
  readonly #client: UpstreamClient;
  readonly #baseUrl: string;

  constructor(client: UpstreamClient, baseUrl: string) {
    this.#client = client;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async listApplications(
    officerToken: string,
    ctx: UpstreamContext,
  ): Promise<readonly ApplicationListRow[]> {
    const response = await this.#get(LIST_APPLICATIONS_PATH, officerToken, ctx, true);
    this.#expect(response, 200, 'list applications');
    return readArray(response.body, 'applications').flatMap((entry) => {
      const row = toListRow(entry);
      return row === null ? [] : [row];
    });
  }

  async listAmberQueue(
    officerToken: string,
    ctx: UpstreamContext,
  ): Promise<readonly AmberQueueRow[]> {
    const response = await this.#get(AMBER_QUEUE_PATH, officerToken, ctx, true);
    this.#expect(response, 200, 'amber queue');
    return readArray(response.body, 'queue').flatMap((entry) => {
      const applicationId = readString(entry, 'applicationId');
      const processingCode = readString(entry, 'processingCode');
      const status = readString(entry, 'status');
      if (applicationId === null || processingCode === null || status === null) return [];
      // Forensic signals ARE carried here on purpose: this is the officer
      // review queue and adjudicating an AMBER hold without the signals that
      // caused it is not review, it is a coin toss. The same fields are absent
      // from every citizen-reachable response.
      return [
        {
          applicationId,
          processingCode,
          status,
          documentType: readString(entry, 'documentType'),
          forensicsScore: readNumber(entry, 'forensicsScore'),
          forensicsFlags: readUnknown(entry, 'forensicsFlags'),
          queuedAt: readString(entry, 'queuedAt'),
        },
      ];
    });
  }

  async findById(
    officerToken: string,
    applicationId: string,
    ctx: UpstreamContext,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const response = await this.#get(
      `${BY_ID_PATH}?applicationId=${encodeURIComponent(applicationId)}`,
      officerToken,
      ctx,
      true,
    );
    // 404 is byte-identical for a nonexistent id and for a sibling agency's
    // real id — upstream only ever queries the caller's own schema, so the two
    // are indistinguishable there and must stay indistinguishable here.
    if (response.status === 404) return null;
    this.#expect(response, 200, 'find application');
    const application = asRecord(readUnknown(response.body, 'application'));
    if (application === null) {
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'by-id response carried no application');
    }
    return stripDenied(application);
  }

  async statusHistory(
    officerToken: string,
    applicationId: string,
    ctx: UpstreamContext,
  ): Promise<readonly StatusHistoryRow[] | null> {
    const response = await this.#get(
      `${STATUS_HISTORY_PATH}?applicationId=${encodeURIComponent(applicationId)}`,
      officerToken,
      ctx,
      true,
    );
    if (response.status === 404) return null;
    this.#expect(response, 200, 'status history');
    return readArray(response.body, 'history').flatMap((entry) => {
      const toStatus = readString(entry, 'toStatus');
      const at = readString(entry, 'at');
      if (toStatus === null || at === null) return [];
      const actorKind = readString(entry, 'actorKind');
      // `actor` — the officer's token subject, a UUID — is NOT carried. The
      // Procedural Justice record owes the applicant a human-readable account
      // of who decided, not an internal user id. No upstream read exposes an
      // officer display name yet, so the honest projection carries the KIND
      // (human vs automated) and omits the identity entirely rather than
      // shipping a UUID a UI would be tempted to render.
      return [
        {
          status: toStatus,
          fromStatus: readString(entry, 'fromStatus'),
          occurredAt: at,
          actorKind: actorKind === 'OFFICER' ? ('OFFICER' as const) : ('SYSTEM' as const),
          note: readString(entry, 'note'),
        },
      ];
    });
  }

  async medicalReview(
    officerToken: string,
    applicationId: string,
    verdict: MedicalVerdict,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome> {
    const body =
      verdict.mode === 'BOARD'
        ? { applicationId, fitnessStatus: verdict.fitnessStatus }
        : {
            applicationId,
            certVerdict: verdict.certVerdict,
            ...(verdict.physicianName !== undefined
              ? { physicianName: verdict.physicianName }
              : {}),
          };
    return toTransitionOutcome(await this.#post(MEDICAL_REVIEW_PATH, officerToken, body, ctx));
  }

  async finalDecision(
    officerToken: string,
    applicationId: string,
    decision: 'SHORTLIST' | 'REJECT',
    notes: string | null,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome> {
    return toTransitionOutcome(
      await this.#post(
        FINAL_DECISION_PATH,
        officerToken,
        { applicationId, decision, ...(notes !== null ? { notes } : {}) },
        ctx,
      ),
    );
  }

  async accept(
    officerToken: string,
    applicationId: string,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome> {
    return toTransitionOutcome(await this.#post(ACCEPT_PATH, officerToken, { applicationId }, ctx));
  }

  async adjudicate(
    officerToken: string,
    applicationId: string,
    decision: 'CLEAR' | 'REJECT',
    notes: string | null,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome> {
    return toTransitionOutcome(
      await this.#post(
        ADJUDICATE_PATH,
        officerToken,
        { applicationId, decision, ...(notes !== null ? { notes } : {}) },
        ctx,
      ),
    );
  }

  async registerWalkIn(
    officerToken: string,
    registration: WalkInRegistration,
    ctx: UpstreamContext,
  ): Promise<WalkInRegisterOutcome> {
    const response = await this.#post(
      WALK_IN_REGISTER_PATH,
      officerToken,
      {
        applicantId: registration.applicantId,
        category: registration.category,
        ...(registration.nesaIndexNumber !== undefined
          ? { nesaIndexNumber: registration.nesaIndexNumber }
          : {}),
        ...(registration.hecRegistrationNumber !== undefined
          ? { hecRegistrationNumber: registration.hecRegistrationNumber }
          : {}),
      },
      ctx,
    );
    const status = readString(response.body, 'status');
    if (response.status === 201 && status === 'REGISTERED') {
      const applicationId = readString(response.body, 'applicationId');
      if (applicationId === null) {
        throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'walk-in registration carried no id');
      }
      // `qrInvitationCode` IS in this response and IS NOT read: it is the
      // bearer credential scanned at the venue, minted for the tablet that
      // registered the candidate. A browser has no use for it and every
      // response it appears in is a place it can leak.
      return { kind: 'REGISTERED', applicationId, status: 'WALK_IN_REGISTERED' };
    }
    if (response.status === 403) return { kind: 'FORBIDDEN' };
    if (response.status === 501) return { kind: 'UNSUPPORTED_AGENCY' };
    if (response.status === 404) return { kind: 'NOT_FOUND' };
    if (response.status === 422) {
      return {
        kind: 'INVALID_INPUT',
        reason: readString(response.body, 'reason') ?? status ?? 'INVALID_INPUT',
      };
    }
    if (response.status === 409) return { kind: 'CONFLICT', reason: status ?? 'CONFLICT' };
    if (response.status === 400) {
      return {
        kind: 'INVALID_INPUT',
        reason: readString(response.body, 'error') ?? 'INVALID_REQUEST',
      };
    }
    throw new UpstreamError('UPSTREAM_UNAVAILABLE', `walk-in register responded ${response.status}`);
  }

  async vetWalkIn(
    officerToken: string,
    applicationId: string,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome> {
    return toTransitionOutcome(
      await this.#post(WALK_IN_VET_PATH, officerToken, { applicationId }, ctx),
    );
  }

  async #get(
    path: string,
    bearer: string,
    ctx: UpstreamContext,
    retryOnG2G: boolean,
  ): Promise<UpstreamResponse> {
    const response = await this.#client.sendOrThrow({
      method: 'GET',
      url: `${this.#baseUrl}${path}`,
      bearer,
      retryOnG2G,
      ctx,
    });
    this.#rejectDeadCredential(response);
    return response;
  }

  async #post(
    path: string,
    bearer: string,
    body: unknown,
    ctx: UpstreamContext,
  ): Promise<UpstreamResponse> {
    const response = await this.#client.sendOrThrow({
      method: 'POST',
      url: `${this.#baseUrl}${path}`,
      bearer,
      body,
      // FALSE for every write, without exception: a retried transition is a
      // double write on a citizen's legal record.
      retryOnG2G: false,
      ctx,
    });
    this.#rejectDeadCredential(response);
    return response;
  }

  #rejectDeadCredential(response: UpstreamResponse): void {
    if (response.status === 401) {
      // The officer JWT expired. It is non-revocable by design (ADR-016), so
      // expiry is the only way it ends — an absolute ceiling, not idleness.
      throw new UpstreamCredentialRejected('absolute');
    }
  }

  #expect(response: UpstreamResponse, status: number, what: string): void {
    if (response.status !== status) {
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', `${what} responded ${response.status}`);
    }
  }
}

function toListRow(entry: unknown): ApplicationListRow | null {
  const applicationId = readString(entry, 'applicationId');
  const processingCode = readString(entry, 'processingCode');
  const category = readString(entry, 'category');
  const status = readString(entry, 'status');
  if (applicationId === null || processingCode === null || category === null || status === null) {
    return null;
  }
  return {
    applicationId,
    processingCode,
    category,
    status,
    submittedAt: readString(entry, 'submittedAt'),
  };
}

/** Drop every deny-listed key. Shallow by design — the detail read is flat. */
function stripDenied(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (DETAIL_DENY_LIST.has(key)) continue;
    out[key] = value;
  }
  return out;
}
