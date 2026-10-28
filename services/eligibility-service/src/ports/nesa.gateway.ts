// ══════════════════════════════════════════════════════════════════
// eligibility-service — NESA gateway port
//
// The application core depends on this interface, never on HTTP/fetch.
// A lookup is keyed by the public examination index number and returns the
// results WITH their holder fields, which the core binds to the applicant
// before evaluating (ADR-048 §2.2).
// ══════════════════════════════════════════════════════════════════

import type { NesaLookupResult } from '../domain/nesa.types.js';

export interface NesaGateway {
  /** NOT_FOUND is a return value; only infrastructure faults throw (NesaUnavailableError). */
  lookupResults(indexNumber: string): Promise<NesaLookupResult>;
}
