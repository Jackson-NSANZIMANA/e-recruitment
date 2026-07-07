// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Event envelope & correlation
//
// Every event carries a stable envelope: a unique eventId, a version, an
// occurredAt timestamp, and the correlation/causation pair that lets us
// trace one applicant's request across every service (correlationId) and
// reconstruct the exact causal chain (causationId = the id of the event
// that triggered this one).
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import type { USRPEvent } from '@usrp/shared-types';

export const EVENT_VERSION = '1.0' as const;

export interface EventEnvelope {
  readonly eventId: string;
  readonly eventVersion: typeof EVENT_VERSION;
  readonly occurredAt: string; // ISO 8601 UTC
  readonly correlationId: string;
  readonly causationId: string;
}

/** Carries the correlation/causation identity forward across a chain. */
export interface EventContext {
  readonly correlationId: string;
  readonly causationId: string;
}

/** Begin a brand-new causal chain (e.g. an inbound applicant request). */
export function newCorrelationContext(): EventContext {
  const id = randomUUID();
  return { correlationId: id, causationId: id };
}

/**
 * Derive the context for an event produced in reaction to `parent`:
 * the correlationId is preserved; the new event's cause is the parent.
 */
export function deriveContext(parent: EventEnvelope): EventContext {
  return { correlationId: parent.correlationId, causationId: parent.eventId };
}

/** Build a fresh envelope for a new event within the given context. */
export function newEnvelope(context: EventContext): EventEnvelope {
  return {
    eventId: randomUUID(),
    eventVersion: EVENT_VERSION,
    occurredAt: new Date().toISOString(),
    correlationId: context.correlationId,
    causationId: context.causationId,
  };
}

/**
 * Type guard: does `value` carry a well-formed event envelope? Used at the
 * consumer boundary before trusting a decoded message.
 */
export function hasValidEnvelope(value: unknown): value is EventEnvelope & { readonly eventType: USRPEvent['eventType'] } {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['eventId'] === 'string' &&
    v['eventVersion'] === EVENT_VERSION &&
    typeof v['occurredAt'] === 'string' &&
    typeof v['correlationId'] === 'string' &&
    typeof v['causationId'] === 'string' &&
    typeof v['eventType'] === 'string'
  );
}
