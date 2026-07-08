// ══════════════════════════════════════════════════════════════════
// eligibility-service — HEC gateway port
//
// The application core depends on this interface, never on HTTP/fetch.
// The adapter owns the HEC-shared HMAC secret and signs every G2G request.
// Unlike NESA (keyed purely by public index number), HEC binds a degree to
// its holder, so the lookup carries the applicant's G2G subject hash — the
// hash is a citizen-linked identifier the adapter must never log.
// ══════════════════════════════════════════════════════════════════

import type { HecLookupResult } from '../domain/hec.types.js';

export interface HecGateway {
  /**
   * Verify a degree/diploma by its registration number AND that it belongs
   * to the holder identified by `holderNidaLookupHash` (the G2G subject
   * hash). HOLDER_MISMATCH and NOT_FOUND are return values; only
   * infrastructure faults throw (HecUnavailableError).
   */
  verifyDegree(registrationNumber: string, holderNidaLookupHash: string): Promise<HecLookupResult>;
}
