// ══════════════════════════════════════════════════════════════════
// @usrp/iam-service — Public API & composition root
//
// Wires the officer-login use case to its PostgreSQL credential adapter and the
// issuer signing key. The event transport is provided by the caller so tests
// inject an InMemoryEventBus and production a KafkaEventBus (see main.ts). The
// issuer private key comes from config — this composition root is the only
// place it is handed to the use case.
// ══════════════════════════════════════════════════════════════════

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { makeAuthVerifier, type AuthVerifier } from '@usrp/shared-auth';
import type { EventBus } from '@usrp/shared-events';
import { PgOfficerAccountRepository } from './adapters/officer-account.pg-repository.js';
import { PgOfficerAdminRepository } from './adapters/officer-admin.pg-repository.js';
import { OfficerAdminService } from './application/officer-admin.service.js';
import { PgServiceAccountRepository } from './adapters/service-account.pg-repository.js';
import { OfficerLoginService } from './application/officer-login.service.js';
import { ServiceTokenService } from './application/service-token.service.js';
import {
  OFFICER_TOKEN_TTL_SECONDS,
  SYSTEM_TOKEN_TTL_SECONDS,
  type IamServiceConfig,
} from './config.js';

export interface IamService {
  readonly login: OfficerLoginService;
  readonly serviceToken: ServiceTokenService;
  /** ADR-036: the agency administrator's officer-lifecycle commands. */
  readonly officerAdmin: OfficerAdminService;
  /**
   * Verifies inbound officer bearer tokens for the officer-admin routes. The
   * public key is DERIVED from the issuer private key iam-service already
   * holds, so no new key material or configuration is introduced.
   */
  readonly verifier: AuthVerifier;
}

/** The issuer's public key (SPKI PEM), derived from its private key. */
export function issuerPublicKeyPem(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

/** Assemble both issuance use cases from config + the event bus. */
export function createIamService(config: IamServiceConfig, bus: EventBus): IamService {
  const accounts = new PgOfficerAccountRepository();
  const login = new OfficerLoginService(accounts, bus, {
    privateKeyPem: config.issuer.authPrivateKeyPem,
    issuer: config.issuer.jwtIssuer,
    audience: config.issuer.jwtAudience,
    tokenTtlSeconds: OFFICER_TOKEN_TTL_SECONDS,
  });
  const serviceAccounts = new PgServiceAccountRepository();
  const serviceToken = new ServiceTokenService(serviceAccounts, bus, {
    privateKeyPem: config.issuer.authPrivateKeyPem,
    issuer: config.issuer.jwtIssuer,
    audience: config.issuer.jwtAudience,
    tokenTtlSeconds: SYSTEM_TOKEN_TTL_SECONDS,
  });
  const officerAdmin = new OfficerAdminService(new PgOfficerAdminRepository());
  const verifier = makeAuthVerifier({
    publicKeyPem: issuerPublicKeyPem(config.issuer.authPrivateKeyPem),
    issuer: config.issuer.jwtIssuer,
    audience: config.issuer.jwtAudience,
  });
  return { login, serviceToken, officerAdmin, verifier };
}

// ── Re-exports ────────────────────────────────────────────────────
export {
  loadIamConfig,
  OFFICER_TOKEN_TTL_SECONDS,
  SYSTEM_TOKEN_TTL_SECONDS,
} from './config.js';
export type { IamServiceConfig } from './config.js';
export {
  OfficerLoginService,
  type OfficerLoginCommand,
  type OfficerLoginConfig,
  type OfficerLoginOutcome,
} from './application/officer-login.service.js';
export {
  ServiceTokenService,
  type ServiceTokenCommand,
  type ServiceTokenConfig,
  type ServiceTokenOutcome,
} from './application/service-token.service.js';
export { officerLoginRoutes, OFFICER_LOGIN_PATH } from './adapters/http/officer-login.controller.js';
export {
  officerAdminRoutes,
  OFFICERS_PATH,
  OFFICER_ACTIVATE_PATH,
  OFFICER_DISABLE_PATH,
  OFFICER_ENABLE_PATH,
  OFFICER_POSTS_PATH,
  OFFICER_REISSUE_ACTIVATION_PATH,
  OFFICER_RELEASE_ACTIVATION_PATH,
  OFFICER_REVOKE_SESSIONS_PATH,
} from './adapters/http/officer-admin.controller.js';
export { OfficerAdminService, type AdminPrincipal } from './application/officer-admin.service.js';
export { PgOfficerAdminRepository } from './adapters/officer-admin.pg-repository.js';
export {
  ASSIGNABLE_POSTS,
  ASSIGN_POSTS_REASONS,
  DISABLE_REASONS,
  ENABLE_REASONS,
  REVOKE_SESSIONS_REASONS,
  type OfficerView,
} from './domain/officer-admin.js';
export { serviceTokenRoutes, SERVICE_TOKEN_PATH } from './adapters/http/service-token.controller.js';
export { PgOfficerAccountRepository } from './adapters/officer-account.pg-repository.js';
export { PgServiceAccountRepository } from './adapters/service-account.pg-repository.js';
export { IamPersistenceError, OfficerAdminForbiddenError } from './domain/iam.errors.js';
export type {
  OfficerAccountRecord,
  OfficerAccountRepository,
  OfficerAccountStatus,
} from './ports/officer-account-repository.js';
export type {
  ServiceAccountRecord,
  ServiceAccountRepository,
  ServiceAccountStatus,
} from './ports/service-account-repository.js';
