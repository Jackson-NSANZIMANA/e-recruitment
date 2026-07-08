// ══════════════════════════════════════════════════════════════════
// background-vetting-service — RIB gateway port
//
// The application core depends on this interface, never on HTTP/fetch. The
// adapter owns the RIB-shared HMAC secret and signs every G2G request. A RIB
// lookup is keyed by the applicant's internal `nationalIdHash` — the same
// system-wide applicant key the front door already carries in
// APPLICANT_SUBMITTED — so the request contains no raw National ID and no PII.
// ══════════════════════════════════════════════════════════════════

import type { RibCheckResult } from '../domain/rib.types.js';

export interface RibGateway {
  /**
   * Resolve an applicant's criminal-records status from RIB by their internal
   * nationalIdHash. Always returns a status flag when reachable (an unknown
   * hash is CLEAR); only infrastructure faults throw (RibUnavailableError).
   */
  checkVetting(nationalIdHash: string): Promise<RibCheckResult>;
}
