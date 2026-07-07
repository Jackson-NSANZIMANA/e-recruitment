// ══════════════════════════════════════════════════════════════════
// identity-service — NIDA gateway port
//
// The application core depends on this interface, never on HTTP/fetch.
// The adapter owns the NIDA-shared HMAC secret and is the ONLY place the
// raw National ID is turned into NIDA's lookup hash — that hash is keyed
// with the NIDA-shared secret and is DISTINCT from USRP's internal
// `nationalIdHash` (keyed with USRP's private NATIONAL_ID_HMAC_KEY).
// ══════════════════════════════════════════════════════════════════

import type { NidaLookupResult } from '../domain/nida.types.js';

export interface NidaGateway {
  /**
   * Resolve a citizen from the raw National ID. The implementation must
   * treat `rawNationalId` as a secret: hash it with the NIDA-shared key
   * for the lookup, sign the G2G request, and NEVER log the raw value.
   */
  lookupCitizen(rawNationalId: string): Promise<NidaLookupResult>;
}
