// ══════════════════════════════════════════════════════════════════
// edge-gateway — IamGateway adapter (officer credential exchange)
//
// The path comes from iam-service's exported OFFICER_LOGIN_PATH, never from a
// string literal here: a hard-coded upstream path in an edge is the same drift
// class that pointed the deprecated frontend doc at a service on :4001 and at
// four BFFs that were never built.
//
// `loginHandle`, NOT `email`. officer_accounts.login_handle is a varchar(128)
// and there is no email column anywhere in the credential store, so the old
// frontend's { email, password } could not have worked against any schema.
// ══════════════════════════════════════════════════════════════════

import { OFFICER_LOGIN_PATH } from '@usrp/iam-service';
import { UpstreamError } from '../../domain/errors.js';
import type { CredentialOutcome, IamGateway, UpstreamContext } from '../../ports/upstream.js';
import { readString, type UpstreamClient } from './http-json.js';

export class HttpIamGateway implements IamGateway {
  readonly #client: UpstreamClient;
  readonly #baseUrl: string;

  constructor(client: UpstreamClient, baseUrl: string) {
    this.#client = client;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async officerLogin(
    loginHandle: string,
    password: string,
    ctx: UpstreamContext,
  ): Promise<CredentialOutcome> {
    const response = await this.#client.sendOrThrow({
      method: 'POST',
      url: `${this.#baseUrl}${OFFICER_LOGIN_PATH}`,
      body: { loginHandle, password },
      // A login is not a G2G read and must never be replayed automatically:
      // a retried failed login burns an account's attempt budget twice.
      retryOnG2G: false,
      ctx,
    });

    // 400 and 401 are BOTH one rejection. Unknown handle, wrong password,
    // disabled account and a malformed field are indistinguishable by
    // contract — a code here would re-enable account enumeration.
    if (response.status === 400 || response.status === 401 || response.status === 429) {
      return { kind: 'REJECTED' };
    }
    if (response.status !== 200) {
      throw new UpstreamError(
        'UPSTREAM_UNAVAILABLE',
        `iam-service login responded ${response.status}`,
      );
    }
    const token = readString(response.body, 'token');
    const expiresAt = readString(response.body, 'expiresAt');
    if (token === null || expiresAt === null) {
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'iam-service login response malformed');
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'iam-service returned an unparseable expiry');
    }
    return { kind: 'OK', token, expiresAt: new Date(expiresAtMs) };
  }
}
