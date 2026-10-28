// ══════════════════════════════════════════════════════════════════
// identity-service — NIDA identity TRANSPORT (swappable at cutover)
//
// Today: HTTPS GET in the IremboGov path, with a G2G client credential and
// the subject NID in a header (the sandbox's nida-irembo simulator, ADR-047
// §3.2). USRP never holds, requests or relays a citizen's Irembo token.
// At cutover the production G2G channel (RISA/IremboGov interoperability;
// mTLS or a signed JWT) replaces THIS module only; the mapping stays.
//
// The raw NID travels to NIDA, which owns it, over TLS in production (the
// production guard refuses a loopback/plain endpoint). It is never logged:
// errors carry only the failure class.
// ══════════════════════════════════════════════════════════════════

import { NidaUnavailableError } from '../domain/identity.errors.js';

export const NIDA_IDENTITY_PATH = '/auth/v1/user-profile-with-identity-info';
export const NIDA_SUBJECT_HEADER = 'x-usrp-subject';

export interface NidaTransportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
}

export interface NidaIremboTransport {
  fetchIdentity(rawNationalId: string, requestId: string): Promise<NidaTransportResponse>;
}

export interface HttpNidaIremboTransportOptions {
  readonly baseUrl: string;
  readonly clientToken: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export class HttpNidaIremboTransport implements NidaIremboTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpNidaIremboTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchIdentity(rawNationalId: string, requestId: string): Promise<NidaTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${NIDA_IDENTITY_PATH}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.options.clientToken}`,
          [NIDA_SUBJECT_HEADER]: rawNationalId,
          'x-request-id': requestId,
        },
        signal: controller.signal,
      });
      return { status: response.status, headers: response.headers, bodyText: await response.text() };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.name : 'unknown';
      throw new NidaUnavailableError(`NIDA request failed (${reason})`, requestId);
    } finally {
      clearTimeout(timer);
    }
  }
}
