// ══════════════════════════════════════════════════════════════════
// iam-service — Service token issuance (use case): client-credentials
//
// The machine mirror of officer login (ADR-016). A service client presents
// { clientId, clientSecret }; on success this mints an Ed25519 kind:'system'
// bearer token — the token every kind:'system' front door (submit,
// eligibility, forensics, identity verify) already accepts. Until this use
// case, no system token was ever minted outside a selfcheck.
//
// Security discipline (identical to login):
//   • NO enumeration — unknown client, wrong secret, and disabled client all
//     return one INVALID_CLIENT outcome (→ 401).
//   • secret verified with scrypt in constant time; the raw secret and the
//     stored digest never leave this function.
//   • TTL is 15 minutes (owner D3, 2026-07-26) — machines re-fetch silently,
//     so a stolen token's window is tight. Officer tokens stay at 1h.
//   • claims carry NO agency and NO roles keys (exactOptionalPropertyTypes:
//     omitted entirely, never undefined) — a system principal is
//     cross-agency by construction (dbRoleForPrincipal → usrp_system_service).
//   • an AUDIT_ENTRY is emitted ONLY on success, PII-free and secret-free
//     (service UUID + 'SYSTEM' labels; never the clientId or any credential).
//   • secret rotation / scopes / mTLS binding are ADR-016 follow-ons.
// ══════════════════════════════════════════════════════════════════

import { newEnvelope, type EventBus, type EventContext } from '@usrp/shared-events';
import { signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import { verifyPassword } from '@usrp/shared-security';
import type { AuditEvent } from '@usrp/shared-types';
import type { ServiceAccountRepository } from '../ports/service-account-repository.js';

export interface ServiceTokenCommand {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly context: EventContext;
}

export type ServiceTokenOutcome =
  | { readonly kind: 'ISSUED'; readonly token: string; readonly expiresAt: string }
  | { readonly kind: 'INVALID_CLIENT' };

export interface ServiceTokenConfig {
  /** Ed25519 issuer PRIVATE key (PKCS#8 PEM). iam-service alone holds it. */
  readonly privateKeyPem: string;
  readonly issuer: string;
  readonly audience: string;
  /** System-token lifetime in seconds (owner D3: 15 minutes). */
  readonly tokenTtlSeconds: number;
}

export class ServiceTokenService {
  readonly #accounts: ServiceAccountRepository;
  readonly #eventBus: EventBus;
  readonly #config: ServiceTokenConfig;
  readonly #now: () => Date;

  constructor(
    accounts: ServiceAccountRepository,
    eventBus: EventBus,
    config: ServiceTokenConfig,
    now: () => Date = () => new Date(),
  ) {
    this.#accounts = accounts;
    this.#eventBus = eventBus;
    this.#config = config;
    this.#now = now;
  }

  async issue(command: ServiceTokenCommand): Promise<ServiceTokenOutcome> {
    const account = await this.#accounts.findByClientId(command.clientId);

    // One indistinguishable rejection for unknown client / wrong secret /
    // disabled client — no enumeration signal.
    if (account === null || account.status !== 'active') {
      return { kind: 'INVALID_CLIENT' };
    }
    if (!verifyPassword(command.clientSecret, account.credential)) {
      return { kind: 'INVALID_CLIENT' };
    }

    const now = this.#now();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#config.tokenTtlSeconds * 1000).toISOString();

    // No agency, no roles — a system principal is cross-agency by kind.
    const claims: AuthTokenClaims = {
      v: 1,
      iss: this.#config.issuer,
      aud: this.#config.audience,
      sub: account.serviceId,
      kind: 'system',
      issuedAt,
      expiresAt,
    };
    const token = signAuthToken(this.#config.privateKeyPem, claims);

    // Success audit — secret-free and PII-free by construction.
    const event: AuditEvent = {
      ...newEnvelope(command.context),
      eventType: 'AUDIT_ENTRY',
      entityType: 'SYSTEM',
      entityId: account.serviceId,
      action: 'SYSTEM_TOKEN_ISSUED',
      performedBy: account.serviceId,
      agency: 'SYSTEM',
      metadata: { method: 'client_credentials' },
    };
    await this.#eventBus.publish(event);

    return { kind: 'ISSUED', token, expiresAt };
  }
}
