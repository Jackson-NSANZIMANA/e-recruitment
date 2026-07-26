// ══════════════════════════════════════════════════════════════════
// iam-service — ServiceAccountRepository port
//
// The machine credential store, abstracted (mirror of the officer port).
// iam-service reads a service account by its unique client id to
// authenticate a client-credentials grant; it never writes through this
// port in the token path (client provisioning is a deferred follow-on).
// The returned record carries the scrypt `credential` digest — verified by
// the use case and NEVER returned past its boundary.
// ══════════════════════════════════════════════════════════════════

export type ServiceAccountStatus = 'active' | 'disabled';

export interface ServiceAccountRecord {
  /** UUID — becomes the minted system token's `sub`. */
  readonly serviceId: string;
  readonly clientId: string;
  /** scrypt digest (shared-security hashPassword). Verified, never returned onward. */
  readonly credential: string;
  readonly status: ServiceAccountStatus;
}

export interface ServiceAccountRepository {
  /** Resolve an account by its unique client id, or null when none exists. */
  findByClientId(clientId: string): Promise<ServiceAccountRecord | null>;
}
