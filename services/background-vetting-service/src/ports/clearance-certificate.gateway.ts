// ══════════════════════════════════════════════════════════════════
// background-vetting-service — ClearanceCertificateGateway port (ADR-048 §2.3)
//
// The application core depends on this interface, never on HTTP. The Irembo
// adapter splits transport from mapping, so the production G2G channel (which
// will differ from the sandbox's, ADR-047 §3.7) swaps one module. The same
// port later verifies NESA equivalence certificates for foreign qualifications.
// ══════════════════════════════════════════════════════════════════

import type { ClearanceLookup } from '../domain/clearance.types.js';

export interface ClearanceCertificateGateway {
  /**
   * Verify a certificate by its (already shape-validated) application number.
   * NOT_FOUND is an answer; a fault throws ClearanceRegistryUnavailableError,
   * which is never a negative verdict.
   */
  verify(applicationNumber: string): Promise<ClearanceLookup>;
}
