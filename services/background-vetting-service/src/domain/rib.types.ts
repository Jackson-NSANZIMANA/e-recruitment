// ══════════════════════════════════════════════════════════════════
// background-vetting-service — RIB domain model
//
// The domain's shape for a criminal-records vetting lookup, decoupled from
// RIB's wire format. The adapter translates the external representation into
// these types so the application core never depends on RIB's HTTP contract.
// Every result carries the `ribRequestId` so the vetting decision is
// traceable back to the exact G2G call in both systems' audit logs.
//
// Note the deliberate coarseness of RIB's answer: a single status flag, no
// case details ("Detailed records require a separate authorized physical
// request" — see RIBVettingResponse in @usrp/shared-types). That coarseness
// is what the criminal-clearance evaluator has to reason about — it is why
// a sentence-length threshold cannot be auto-decided from HAS_RECORDS alone.
// ══════════════════════════════════════════════════════════════════

import type { RIBRecordStatus } from '@usrp/shared-types';

/**
 * Outcome of a RIB criminal-records lookup, keyed by the applicant's
 * internal `nationalIdHash`. RIB always answers (there is no "not found" —
 * an unknown hash is simply CLEAR), so unlike NESA there is no NOT_FOUND
 * business branch: every reachable call yields a status flag.
 */
export interface RibCheckResult {
  readonly status: RIBRecordStatus; // CLEAR | HAS_RECORDS | UNDER_INVESTIGATION
  readonly ribRequestId: string;
}

/**
 * RIB could not be reached, timed out, or returned a non-2xx / malformed
 * response. An infrastructure fault — never a statement about the applicant.
 * Carries the `ribRequestId` for cross-system tracing. In the event-driven
 * path this PROPAGATES out of the consumer so the Kafka offset is not
 * committed and the vetting is retried — we never fabricate a clearance
 * verdict from an unreachable registry (fail-closed).
 */
export class RibUnavailableError extends Error {
  constructor(
    message: string,
    readonly ribRequestId: string,
  ) {
    super(message);
    this.name = 'RibUnavailableError';
  }
}
