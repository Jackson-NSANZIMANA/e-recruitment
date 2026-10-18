// ══════════════════════════════════════════════════════════════════
// iam-service — OfficerAccountRepository port
//
// The credential store, abstracted. iam-service reads an officer account by its
// login handle to authenticate a login. Its one write is the last-login stamp,
// through the narrow rls/0033 officer_record_login function (ADR-036). The returned record
// carries the scrypt `credential` digest — the service verifies against it and
// NEVER returns it past the use-case boundary.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

/** 'pending' (ADR-036) = created by an administrator, activation code not yet redeemed. */
export type OfficerAccountStatus = 'active' | 'disabled' | 'pending';

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
  /** Stamp a successful login (ADR-036: listOfficers shows last login). */
  recordSuccessfulLogin(officerId: string): Promise<void>;
}
