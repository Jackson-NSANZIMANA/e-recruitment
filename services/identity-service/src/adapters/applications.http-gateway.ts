// ══════════════════════════════════════════════════════════════════
// identity-service — ApplicationsGateway adapter (HTTP, client-credentials)
//
// The first PRODUCTION consumer of ADR-016: identity-service authenticates
// to application-service machine-to-machine — fetch a 15-minute
// kind:'system' token from iam-service with its own client credentials,
// call GET /v1/applications/by-applicant, re-fetch the token as it nears
// expiry. The client secret lives in config only; it is never logged and
// never appears in an error.
// ══════════════════════════════════════════════════════════════════

import { UpstreamUnavailableError } from '../domain/identity.errors.js';
import type {
  ApplicantApplication,
  ApplicantSubmitInput,
  ApplicantSubmitResult,
  ApplicationsGateway,
  WithdrawApplicationResult,
} from '../ports/applications-gateway.js';

export interface HttpApplicationsGatewayOptions {
  /** iam-service base URL (token endpoint host). */
  readonly iamBaseUrl: string;
  /** application-service base URL (the by-applicant read host). */
  readonly applicationBaseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Re-fetch the system token when it is within this window of expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export class HttpApplicationsGateway implements ApplicationsGateway {
  readonly #opts: HttpApplicationsGatewayOptions;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #cached: CachedToken | null = null;

  constructor(options: HttpApplicationsGatewayOptions) {
    this.#opts = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listForApplicant(applicantId: string): Promise<readonly ApplicantApplication[]> {
    const token = await this.#systemToken();
    let res: Response;
    try {
      res = await this.#fetch(
        `${this.#opts.applicationBaseUrl}/v1/applications/by-applicant?applicantId=${encodeURIComponent(applicantId)}`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
    } catch (cause) {
      throw new UpstreamUnavailableError('application-service unreachable', { cause });
    }
    if (res.status === 401) {
      // Token expired between cache check and use — drop it; the next call
      // mints fresh. This request fails honestly rather than retrying blind.
      this.#cached = null;
    }
    if (res.status !== 200) {
      throw new UpstreamUnavailableError(`application-service responded ${res.status}`);
    }
    const body = (await res.json()) as { applications?: ApplicantApplication[] };
    return body.applications ?? [];
  }

  async withdrawApplication(
    applicantId: string,
    applicationId: string,
  ): Promise<WithdrawApplicationResult> {
    const token = await this.#systemToken();
    let res: Response;
    try {
      res = await this.#fetch(`${this.#opts.applicationBaseUrl}/v1/applications/withdraw-own`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ applicantId, applicationId }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new UpstreamUnavailableError('application-service unreachable', { cause });
    }
    if (res.status === 401) {
      this.#cached = null; // same expiry-race posture as the read path
    }
    if (res.status === 404) {
      return { kind: 'NOT_FOUND' };
    }
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      agency?: string;
      fromStatus?: string;
      currentStatus?: string;
    };
    if (res.status === 200 && body.status === 'WITHDRAWN' && body.agency && body.fromStatus) {
      return { kind: 'WITHDRAWN', agency: body.agency, fromStatus: body.fromStatus };
    }
    if (res.status === 200 && body.status === 'NO_CHANGE' && body.agency) {
      return { kind: 'NO_CHANGE', agency: body.agency };
    }
    if (res.status === 409 && body.status === 'NOT_APPLICABLE' && body.agency && body.currentStatus) {
      return { kind: 'NOT_APPLICABLE', agency: body.agency, currentStatus: body.currentStatus };
    }
    throw new UpstreamUnavailableError(`application-service withdraw-own responded ${res.status}`);
  }

  /**
   * Submit the citizen's own application through application-service's
   * idempotent front door (ADR-027): POST /v1/applications with the
   * identity-service system token, the EXACT validated Idempotency-Key, and
   * an allowlisted body whose subject is server-derived and whose channel is
   * pinned to WEB.
   *
   * TOTAL, never throwing for upstream behaviour: transport faults, 5xx and
   * token rejection collapse to DEPENDENCY_UNAVAILABLE (nothing was
   * written); a response that does not match the pinned contract collapses
   * to UNEXPECTED_UPSTREAM_RESPONSE with the body discarded — an unexpected
   * shape is a wiring bug, and its content is not ours to relay.
   */
  async submitForApplicant(
    applicantId: string,
    input: ApplicantSubmitInput,
    idempotencyKey: string,
  ): Promise<ApplicantSubmitResult> {
    // Allowlisted body ONLY. applicantId is the session-derived subject; the
    // browser channel is a server-side fact; nothing else travels.
    const body = {
      applicantId,
      category: input.category,
      channel: 'WEB' as const,
      ...(input.nesaIndexNumber === null || input.nesaIndexNumber === undefined
        ? {}
        : { nesaIndexNumber: input.nesaIndexNumber }),
      ...(input.hecRegistrationNumber === null || input.hecRegistrationNumber === undefined
        ? {}
        : { hecRegistrationNumber: input.hecRegistrationNumber }),
    };

    let token: string;
    try {
      token = await this.#systemToken();
    } catch {
      return { kind: 'DEPENDENCY_UNAVAILABLE' };
    }

    let res: Response;
    try {
      res = await this.#fetch(`${this.#opts.applicationBaseUrl}/v1/applications`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          // The caller's retry identity, forwarded EXACTLY (ADR-027).
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // Timeout, DNS failure, connection refused — nothing was written.
      return { kind: 'DEPENDENCY_UNAVAILABLE' };
    }
    if (res.status === 401) {
      // The system token was rejected: a dependency/configuration fault, not
      // an applicant answer. Drop the cache so the next call mints fresh.
      this.#cached = null;
      return { kind: 'DEPENDENCY_UNAVAILABLE' };
    }
    if (res.status >= 500) {
      return { kind: 'DEPENDENCY_UNAVAILABLE' };
    }

    const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const status = parsed?.['status'];
    const applicationId = parsed?.['applicationId'];
    const processingCode = parsed?.['processingCode'];
    const agency = parsed?.['agency'];
    const identifiersOk =
      typeof applicationId === 'string' &&
      applicationId.length > 0 &&
      typeof processingCode === 'string' &&
      processingCode.length > 0 &&
      typeof agency === 'string' &&
      agency.length > 0;

    if (res.status === 201) {
      // Replay is recognised ONLY on the exact combination application-service
      // emits: 201 + Idempotency-Replayed: true. Any other header value is an
      // unexpected shape, never guessed at.
      const replayed = res.headers.get('idempotency-replayed');
      if (replayed !== null && replayed !== 'true') {
        return { kind: 'UNEXPECTED_UPSTREAM_RESPONSE' };
      }
      if (status !== 'SUBMITTED' || !identifiersOk) {
        return { kind: 'UNEXPECTED_UPSTREAM_RESPONSE' };
      }
      return replayed === 'true'
        ? {
            kind: 'REPLAYED',
            applicationId,
            processingCode,
            agency,
          }
        : {
            kind: 'SUBMITTED',
            applicationId,
            processingCode,
            agency,
          };
    }

    if (res.status === 409 && status === 'KEY_REUSED') {
      // Identifier-free BY CONTRACT (ADR-027): the key belongs to a different
      // submission and echoing that submission's ids would leak across
      // requests. Only the static reason text survives.
      return typeof parsed?.['reason'] === 'string'
        ? { kind: 'KEY_REUSED', reason: parsed['reason'] }
        : { kind: 'KEY_REUSED', reason: 'This Idempotency-Key was already used for a different submission.' };
    }
    if (res.status === 409 && status === 'ALREADY_APPLIED' && identifiersOk) {
      return { kind: 'ALREADY_APPLIED', applicationId, processingCode, agency };
    }
    if (res.status === 409 && status === 'IDENTITY_NOT_VERIFIED') {
      return { kind: 'IDENTITY_NOT_VERIFIED' };
    }
    if (res.status === 409 && status === 'NO_OPEN_CAMPAIGN' && typeof agency === 'string') {
      return { kind: 'NO_OPEN_CAMPAIGN', agency };
    }
    if (res.status === 404 && status === 'APPLICANT_NOT_FOUND') {
      return { kind: 'APPLICANT_NOT_FOUND' };
    }
    if (
      res.status === 422 &&
      status === 'INVALID_ACADEMIC_INPUT' &&
      typeof parsed?.['reason'] === 'string'
    ) {
      return { kind: 'INVALID_ACADEMIC_INPUT', reason: parsed['reason'] };
    }

    // Anything else — wrong status for the body's status string, a missing
    // field, an undocumented code — is a contract mismatch. The raw body is
    // deliberately discarded here and never logged.
    return { kind: 'UNEXPECTED_UPSTREAM_RESPONSE' };
  }

  /** The cached system token, minting a fresh one when absent/near expiry. */
  async #systemToken(): Promise<string> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAtMs - now > TOKEN_REFRESH_MARGIN_MS) {
      return this.#cached.token;
    }
    let res: Response;
    try {
      res = await this.#fetch(`${this.#opts.iamBaseUrl}/v1/auth/service/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: this.#opts.clientId, clientSecret: this.#opts.clientSecret }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw new UpstreamUnavailableError('iam-service unreachable', { cause });
    }
    if (res.status !== 200) {
      // Never echo credentials — the status alone is the diagnostic.
      throw new UpstreamUnavailableError(`iam-service token request responded ${res.status}`);
    }
    const body = (await res.json()) as { token?: string; expiresAt?: string };
    if (typeof body.token !== 'string' || typeof body.expiresAt !== 'string') {
      throw new UpstreamUnavailableError('iam-service token response malformed');
    }
    this.#cached = { token: body.token, expiresAtMs: Date.parse(body.expiresAt) };
    return body.token;
  }
}
