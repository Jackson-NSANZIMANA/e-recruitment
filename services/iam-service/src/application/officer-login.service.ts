// ══════════════════════════════════════════════════════════════════
// iam-service — Officer login (use case): the token issuer
//
// The keystone of the go-live vertical. An officer presents { loginHandle,
// password }; on success this mints an Ed25519 bearer token — the SAME token
// format the Slice-4 officer endpoints already accept (signAuthToken /
// makeAuthVerifier). iam-service is the sole holder of the issuer PRIVATE key.
//
// Security discipline:
//   • NO user-enumeration — unknown handle, wrong password, and disabled
//     account all return one identical INVALID_CREDENTIALS outcome (→ 401).
//   • password verified with scrypt in constant time (verifyPassword); the raw
//     password and the stored digest never leave this function.
//   • the token `sub` is the officer UUID — it lands in the UUID
//     medical_reviewed_by_id / final_decision_by_id stamp columns (Slice 4).
//   • an AUDIT_ENTRY is emitted ONLY on success, PII-free (opaque officer id +
//     agency; never the handle, password, or hash).
//   • MFA / lockout / rate-limiting are flagged follow-ons, not this slice.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import { signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import { verifyPassword } from '@usrp/shared-security';
import type { AuditEvent } from '@usrp/shared-types';
import type { OfficerAccountRepository } from '../ports/officer-account-repository.js';

export interface OfficerLoginCommand {
  readonly loginHandle: string;
  readonly password: string;
  readonly context: EventContext;
}

export type OfficerLoginOutcome =
  | { readonly kind: 'AUTHENTICATED'; readonly token: string; readonly expiresAt: string }
  | { readonly kind: 'INVALID_CREDENTIALS' };

export interface OfficerLoginConfig {
  /** Ed25519 issuer PRIVATE key (PKCS#8 PEM). iam-service alone holds it. */
  readonly privateKeyPem: string;
  readonly issuer: string;
  readonly audience: string;
  /** Bearer-token lifetime in seconds (owner-decided: 1h). */
  readonly tokenTtlSeconds: number;
}

export class OfficerLoginService {
  readonly #accounts: OfficerAccountRepository;
  readonly #eventBus: EventBus;
  readonly #config: OfficerLoginConfig;
  readonly #now: () => Date;

  constructor(
    accounts: OfficerAccountRepository,
    eventBus: EventBus,
    config: OfficerLoginConfig,
    now: () => Date = () => new Date(),
  ) {
    this.#accounts = accounts;
    this.#eventBus = eventBus;
    this.#config = config;
    this.#now = now;
  }

  async login(command: OfficerLoginCommand): Promise<OfficerLoginOutcome> {
    const account = await this.#accounts.findByHandle(command.loginHandle);

    // One indistinguishable rejection for unknown handle / wrong password /
    // disabled account — no user-enumeration signal. (We still verify a bogus
    // password shape below only when an account exists; a timing oracle on
    // existence is out of scope for this slice and flagged with rate-limiting.)
    if (account === null || account.status !== 'active') {
      return { kind: 'INVALID_CREDENTIALS' };
    }
    if (!verifyPassword(command.password, account.credential)) {
      return { kind: 'INVALID_CREDENTIALS' };
    }

    const now = this.#now();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#config.tokenTtlSeconds * 1000).toISOString();

    const claims: AuthTokenClaims = {
      v: 1,
      iss: this.#config.issuer,
      aud: this.#config.audience,
      sub: account.officerId,
      kind: 'officer',
      agency: account.agency,
      roles: account.roles,
      issuedAt,
      expiresAt,
    };
    const token = signAuthToken(this.#config.privateKeyPem, claims);

    // Success audit — PII-free by construction.
    const event: AuditEvent = {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'OFFICER',
      entityId: account.officerId,
      action: 'OFFICER_LOGIN_SUCCEEDED',
      performedBy: account.officerId,
      agency: account.agency,
      metadata: { method: 'password' },
    };
    await this.#eventBus.publish(event);

    return { kind: 'AUTHENTICATED', token, expiresAt };
  }
}
