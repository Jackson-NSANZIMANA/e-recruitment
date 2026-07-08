// ══════════════════════════════════════════════════════════════════
// eligibility-service — NESA gateway port
//
// The application core depends on this interface, never on HTTP/fetch.
// The adapter owns the NESA-shared HMAC secret and signs every G2G
// request. Unlike NIDA/HEC, a NESA lookup is keyed purely by the public
// examination index number — it carries no National ID and no PII in the
// request, so nothing here needs the applicant's raw identity.
// ══════════════════════════════════════════════════════════════════

import type { NesaLookupResult } from '../domain/nesa.types.js';

export interface NesaGateway {
  /**
   * Resolve a candidate's verified A-Level results from their NESA
   * examination index number. NOT_FOUND is a return value; only
   * infrastructure faults throw (NesaUnavailableError).
   */
  lookupResults(indexNumber: string): Promise<NesaLookupResult>;
}
