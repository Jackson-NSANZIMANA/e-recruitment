// ══════════════════════════════════════════════════════════════════
// iam-service — OfficerAccountRepository port
//
// The credential store, abstracted. iam-service reads an officer account by its
// login handle to authenticate a login; it never writes through this port in
// the login path (provisioning is a deferred follow-on). The returned record
// carries the scrypt `credential` digest — the service verifies against it and
// NEVER returns it past the use-case boundary.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

export type OfficerAccountStatus = 'active' | 'disabled';

export interface OfficerAccountRecord {
  /** UUID — becomes the minted token's `sub`, and the officer-stamp columns. */
  readonly officerId: string;
  readonly loginHandle: string;
  /** scrypt digest (shared-security hashPassword). Verified, never returned onward. */
  readonly credential: string;
  readonly agency: Agency;
  readonly roles: readonly string[];
  readonly status: OfficerAccountStatus;
}

export interface OfficerAccountRepository {
  /** Resolve an account by its unique login handle, or null when none exists. */
  findByHandle(loginHandle: string): Promise<OfficerAccountRecord | null>;
}
