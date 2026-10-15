// ══════════════════════════════════════════════════════════════════
// application-service — Re-announce stalled clearances (sweep)
//
// THE FAILURE IT CLOSES. APPLICATION_ELIGIBILITY_CLEARED is announced ONCE, on
// the transition into DOCUMENT_REVIEW_GREEN. When scheduling cannot place the
// applicant (NO_VENUE_FOR_DISTRICT: the district's venue list is not published
// yet; VENUE_AT_CAPACITY / VENUE_INACTIVE) it audits a deferral and stops.
// Nothing ever asked again, so publishing the venue or raising capacity later
// left those citizens at GREEN for good: no slot, no exam QR (ADR-033 shows
// PENDING forever).
//
// THE FIX. Periodically re-announce the clearance for rows stalled at GREEN
// with no slot, once each per grace period. It is safe because scheduling is
// idempotent per application (ADR-026 slot ledger): an already-assigned
// application re-announces its ORIGINAL SLOT_ASSIGNED (which also heals a lost
// projection), and a still-unplaceable one records another deferral.
//
// Bounded: `batchSize` rows per agency per tick, each row at most once per
// `graceMs` (the claim bumps updated_at), only for campaigns that can still
// hold an exam. Staged in the outbox, so a re-announce is as durable as the
// original.
// ══════════════════════════════════════════════════════════════════

import { newCorrelationContext, newEnvelope } from '@usrp/shared-events';
import type { ApplicationEligibilityClearedEvent } from '@usrp/shared-types';
import type { EventDispatcher } from '../ports/event-outbox.js';
import type { StalledClearance, StalledClearanceRepository } from '../ports/stalled-clearance-repository.js';

export interface SlotRetryPolicy {
  /** A row must be untouched this long before it is re-announced. */
  readonly graceMs: number;
  /** Rows claimed per agency per tick. */
  readonly batchSize: number;
}

export interface ReannounceStalledClearancesDeps {
  readonly repository: StalledClearanceRepository;
  readonly events: EventDispatcher;
  readonly policy: SlotRetryPolicy;
}

export function clearanceEvents(stalled: readonly StalledClearance[]): readonly ApplicationEligibilityClearedEvent[] {
  return stalled.map((s) => ({
    ...newEnvelope(newCorrelationContext()),
    eventType: 'APPLICATION_ELIGIBILITY_CLEARED',
    applicationId: s.applicationId,
    applicantId: s.applicantId,
    agency: s.agency,
    campaignId: s.campaignId,
    category: s.category,
  }));
}

export class ReannounceStalledClearancesService {
  constructor(private readonly deps: ReannounceStalledClearancesDeps) {}

  /** One tick. Returns how many clearances were re-announced. */
  async sweep(now: Date = new Date()): Promise<number> {
    const untouchedSince = new Date(now.getTime() - this.deps.policy.graceMs);
    const events = await this.deps.repository.reannounce(untouchedSince, this.deps.policy.batchSize, clearanceEvents);
    // The callback mints envelopes, so the staged events ARE these events:
    // dispatch exactly what was staged (same eventIds), never re-mint.
    if (events.length > 0) await this.deps.events.dispatch(events);
    return events.length;
  }
}
