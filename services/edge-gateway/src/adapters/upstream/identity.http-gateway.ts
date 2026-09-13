// ══════════════════════════════════════════════════════════════════
// edge-gateway — IdentityGateway adapter
//
// Fronts identity-service: citizen OTP auth, the citizen me-routes, and the
// ONE brokered service-internal route (verifyIdentity, ADR-012 D1).
//
// THE APPLICANT CREDENTIAL IS A BEARER OF THE OPAQUE DB TOKEN. identity-service
// authenticates the me-routes with the opaque session token as a Bearer (owner
// D5) and validates it live against applicant_sessions, so revocation is
// honoured on the next request. The edge holds that token and presents it; the
// browser never sees it.
//
// A 401 from any me-route therefore means the citizen's session was revoked or
// expired upstream. It is translated into UpstreamCredentialRejected so the
// handler destroys the edge handle too — otherwise a revoked citizen session
// would keep looking alive to the browser, which is the exact property ADR-018
// paid for with a DB round trip per request.
// ══════════════════════════════════════════════════════════════════

import {
  LOGOUT_PATH,
  ME_APPLICATIONS_PATH,
  ME_ERASURE_REQUEST_PATH,
  OTP_REQUEST_PATH,
  OTP_VERIFY_PATH,
  VERIFY_IDENTITY_PATH,
} from '@usrp/identity-service';
import type { ApplicationChannel } from '@usrp/shared-types';
import { UpstreamCredentialRejected, UpstreamError } from '../../domain/errors.js';
import type {
  CredentialOutcome,
  ErasureRequestOutcome,
  IdentityGateway,
  IdentityVerifyOutcome,
  MyApplicationRow,
  TransitionOutcome,
  UpstreamContext,
} from '../../ports/upstream.js';
import { readArray, readString, type UpstreamClient, type UpstreamResponse } from './http-json.js';
import { toTransitionOutcome } from './transition-outcome.js';

/**
 * A GAP IN THE UPSTREAM PUBLIC SURFACE, composed rather than retyped.
 *
 * identity-service defines ME_WITHDRAW_PATH in its applicant-auth controller
 * but does NOT re-export it from its index, unlike the constants above — so the
 * citizen's own withdrawal route (ADR-020) is currently unreachable from any
 * other package. Deriving it from the exported ME_APPLICATIONS_PATH keeps ONE
 * hard-coded segment instead of a whole duplicated path, so a change to the
 * me-route prefix still propagates.
 *
 * THE PROPER FIX IS ONE LINE IN identity-service/src/index.ts (add
 * ME_WITHDRAW_PATH to the applicant-auth export block); this composition should
 * be deleted the moment it lands. Recorded in docs/CONTRACT-DEVIATIONS.md.
 */
const ME_WITHDRAW_PATH = `${ME_APPLICATIONS_PATH}/withdraw`;

export class HttpIdentityGateway implements IdentityGateway {
  readonly #client: UpstreamClient;
  readonly #baseUrl: string;

  constructor(client: UpstreamClient, baseUrl: string) {
    this.#client = client;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async requestOtp(
    nationalId: string,
    channel: ApplicationChannel,
    ctx: UpstreamContext,
  ): Promise<'ACCEPTED' | 'MALFORMED'> {
    const response = await this.#client.sendOrThrow({
      method: 'POST',
      url: this.#url(OTP_REQUEST_PATH),
      body: { nationalId, channel },
      // Retryable: the upstream path does a live NIDA lookup, and re-requesting
      // a challenge is idempotent from the citizen's point of view (the newest
      // live challenge wins). The registry, not this call site, decides.
      retryOnG2G: true,
      ctx,
    });
    if (response.status === 202) return 'ACCEPTED';
    // Structural failure ONLY. Upstream answers 202 uniformly for every
    // outcome that depends on the subject, so there is nothing here that
    // could tell a caller whether a National ID exists.
    if (response.status === 400) return 'MALFORMED';
    throw new UpstreamError('UPSTREAM_UNAVAILABLE', `otp/request responded ${response.status}`);
  }

  async verifyOtp(
    nationalId: string,
    otp: string,
    channel: ApplicationChannel,
    ctx: UpstreamContext,
  ): Promise<CredentialOutcome> {
    const response = await this.#client.sendOrThrow({
      method: 'POST',
      url: this.#url(OTP_VERIFY_PATH),
      body: { nationalId, otp, channel },
      // NOT retryable: a retry spends one of the challenge's five attempts.
      retryOnG2G: false,
      ctx,
    });
    if (response.status === 400 || response.status === 401) return { kind: 'REJECTED' };
    if (response.status !== 200) {
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', `otp/verify responded ${response.status}`);
    }
    const sessionToken = readString(response.body, 'sessionToken');
    const expiresAt = readString(response.body, 'expiresAt');
    if (sessionToken === null || expiresAt === null) {
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'otp/verify response malformed');
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'otp/verify returned an unparseable expiry');
    }
    return { kind: 'OK', token: sessionToken, expiresAt: new Date(expiresAtMs) };
  }

  async revokeApplicantSession(sessionToken: string, ctx: UpstreamContext): Promise<void> {
    const response = await this.#client.send({
      method: 'POST',
      url: this.#url(LOGOUT_PATH),
      bearer: sessionToken,
      retryOnG2G: false,
      ctx,
    });
    // 204 revoked, 401 already dead. Both are "the token is not usable any
    // more", which is all logout promises. Anything else is a real fault — but
    // it must NOT stop the caller destroying the edge handle, so the caller
    // treats this as best-effort.
    if (response.status !== 204 && response.status !== 401) {
      throw new UpstreamError(
        'UPSTREAM_UNAVAILABLE',
        `applicant logout responded ${response.status}`,
      );
    }
  }

  async verifyIdentity(
    officerToken: string,
    nationalId: string,
    channel: ApplicationChannel,
    ctx: UpstreamContext,
  ): Promise<IdentityVerifyOutcome> {
    const response = await this.#client.sendOrThrow({
      method: 'POST',
      url: this.#url(VERIFY_IDENTITY_PATH),
      bearer: officerToken,
      body: { nationalId, channel },
      retryOnG2G: true,
      ctx,
    });
    if (response.status === 401) throw new UpstreamCredentialRejected('absolute');
    // 201 CREATED (first sight of this citizen) and 200 ALREADY_EXISTS are the
    // same answer to the officer's question: NIDA knows this National ID.
    if (response.status === 201 || response.status === 200) {
      const applicantId = readString(response.body, 'applicantId');
      if (applicantId === null) {
        throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'verify response missing applicantId');
      }
      return { kind: 'VERIFIED', applicantId };
    }
    // 404 NOT_FOUND_IN_NIDA and 422 NOT_A_CITIZEN both mean "not verified".
    // They are NOT distinguished onward: the difference is a fact about a
    // person, and this endpoint is reachable by any officer in the country.
    if (response.status === 404 || response.status === 422) return { kind: 'UNVERIFIED' };
    throw new UpstreamError('UPSTREAM_UNAVAILABLE', `identity verify responded ${response.status}`);
  }

  async listMyApplications(
    sessionToken: string,
    ctx: UpstreamContext,
  ): Promise<readonly MyApplicationRow[]> {
    const response = await this.#client.sendOrThrow({
      method: 'GET',
      url: this.#url(ME_APPLICATIONS_PATH),
      bearer: sessionToken,
      retryOnG2G: true,
      ctx,
    });
    this.#rejectDeadCredential(response);
    if (response.status !== 200) {
      throw new UpstreamError(
        'UPSTREAM_UNAVAILABLE',
        `me/applications responded ${response.status}`,
      );
    }
    const rows: MyApplicationRow[] = [];
    for (const entry of readArray(response.body, 'applications')) {
      const applicationId = readString(entry, 'applicationId');
      const processingCode = readString(entry, 'processingCode');
      const category = readString(entry, 'category');
      const status = readString(entry, 'status');
      const agency = readString(entry, 'agency');
      if (
        applicationId === null ||
        processingCode === null ||
        category === null ||
        status === null ||
        agency === null
      ) {
        continue;
      }
      // NOTE THE ALLOWLIST: nothing forensic is copied. A lane, score or flag
      // handed to the person who uploaded the file is a forgery-tuning oracle
      // (edit, re-upload, watch the number move, repeat until GREEN), so the
      // citizen row carries the processing status and nothing else.
      rows.push({
        applicationId,
        processingCode,
        category,
        status,
        agency,
        submittedAt: readString(entry, 'submittedAt'),
      });
    }
    return rows;
  }

  async withdrawMyApplication(
    sessionToken: string,
    applicationId: string,
    ctx: UpstreamContext,
  ): Promise<TransitionOutcome> {
    const response = await this.#client.sendOrThrow({
      method: 'POST',
      url: this.#url(ME_WITHDRAW_PATH),
      bearer: sessionToken,
      // Ownership is enforced upstream against the session subject, never
      // against a body field — there is no applicantId to send and therefore
      // none to tamper with.
      body: { applicationId },
      retryOnG2G: false,
      ctx,
    });
    this.#rejectDeadCredential(response);
    return toTransitionOutcome(response);
  }

  async getMyErasureRequest(
    sessionToken: string,
    ctx: UpstreamContext,
  ): Promise<ErasureRequestOutcome> {
    const response = await this.#client.sendOrThrow({
      method: 'GET',
      url: this.#url(ME_ERASURE_REQUEST_PATH),
      bearer: sessionToken,
      retryOnG2G: true,
      ctx,
    });
    this.#rejectDeadCredential(response);
    // Upstream says "no request on file" with a 404. That is an ABSENCE, not
    // an error, for a data-subject right the citizen is entitled to check —
    // so it becomes an explicit `exists: false` rather than a 404 the SPA has
    // to special-case in an error boundary.
    if (response.status === 404) return { kind: 'NONE' };
    if (response.status !== 200) {
      throw new UpstreamError(
        'UPSTREAM_UNAVAILABLE',
        `me/erasure-request responded ${response.status}`,
      );
    }
    const status = readString(response.body, 'status');
    const filedAt = readString(response.body, 'requestedAt');
    if (status === null || filedAt === null) {
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'erasure-request response malformed');
    }
    // requestId is deliberately NOT forwarded: it addresses the DPO queue's
    // decline route, which is an officer surface. The citizen's own request is
    // already session-scoped, so an id buys them nothing.
    return {
      kind: 'FOUND',
      status,
      filedAt,
      decidedAt: readString(response.body, 'decidedAt'),
      decisionNote: readString(response.body, 'decisionNote'),
    };
  }

  async fileMyErasureRequest(sessionToken: string, ctx: UpstreamContext): Promise<void> {
    const response = await this.#client.sendOrThrow({
      method: 'POST',
      url: this.#url(ME_ERASURE_REQUEST_PATH),
      bearer: sessionToken,
      body: {},
      retryOnG2G: false,
      ctx,
    });
    this.#rejectDeadCredential(response);
    // Upstream files IDEMPOTENTLY and answers 202 whether the request is new or
    // already live ("the demand is on record, a human decides next"). There is
    // therefore no 409 to surface — see docs/CONTRACT-DEVIATIONS.md.
    if (response.status !== 202) {
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', `erasure filing responded ${response.status}`);
    }
  }

  #url(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  #rejectDeadCredential(response: UpstreamResponse): void {
    if (response.status === 401) {
      // The opaque token was revoked or expired upstream. ADR-018's whole
      // point: propagate it, do not paper over it.
      throw new UpstreamCredentialRejected('revoked');
    }
  }
}
