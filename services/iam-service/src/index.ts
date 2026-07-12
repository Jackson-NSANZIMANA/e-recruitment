// ══════════════════════════════════════════════════════════════════
// @usrp/iam-service — Public API & composition root
//
// Wires the officer-login use case to its PostgreSQL credential adapter and the
// issuer signing key. The event transport is provided by the caller so tests
// inject an InMemoryEventBus and production a KafkaEventBus (see main.ts). The
// issuer private key comes from config — this composition root is the only
// place it is handed to the use case.
// ══════════════════════════════════════════════════════════════════

import type { EventBus } from '@usrp/shared-events';
import { PgOfficerAccountRepository } from './adapters/officer-account.pg-repository.js';
import { OfficerLoginService } from './application/officer-login.service.js';
import { OFFICER_TOKEN_TTL_SECONDS, type IamServiceConfig } from './config.js';

export interface IamService {
  readonly login: OfficerLoginService;
}

/** Assemble the officer-login use case from config + the event bus. */
export function createIamService(config: IamServiceConfig, bus: EventBus): IamService {
  const accounts = new PgOfficerAccountRepository();
  const login = new OfficerLoginService(accounts, bus, {
    privateKeyPem: config.issuer.authPrivateKeyPem,
    issuer: config.issuer.jwtIssuer,
    audience: config.issuer.jwtAudience,
    tokenTtlSeconds: OFFICER_TOKEN_TTL_SECONDS,
  });
  return { login };
}

// ── Re-exports ────────────────────────────────────────────────────
export { loadIamConfig, OFFICER_TOKEN_TTL_SECONDS } from './config.js';
export type { IamServiceConfig } from './config.js';
export {
  OfficerLoginService,
  type OfficerLoginCommand,
  type OfficerLoginConfig,
  type OfficerLoginOutcome,
} from './application/officer-login.service.js';
export { officerLoginRoutes, OFFICER_LOGIN_PATH } from './adapters/http/officer-login.controller.js';
export { PgOfficerAccountRepository } from './adapters/officer-account.pg-repository.js';
export { IamPersistenceError } from './domain/iam.errors.js';
export type {
  OfficerAccountRecord,
  OfficerAccountRepository,
  OfficerAccountStatus,
} from './ports/officer-account-repository.js';
