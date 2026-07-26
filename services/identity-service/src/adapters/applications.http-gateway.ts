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
