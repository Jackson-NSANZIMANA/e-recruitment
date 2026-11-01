// ══════════════════════════════════════════════════════════════════
// application-service — a human's decision outranks a machine's (pure domain)
//
// Once an officer resolved a held vetting dimension (the CRIMINAL or ACADEMIC
// lane of `adjudicate`), that dimension belongs to the decision. A verdict that
// arrives LATER from the machine side — a Kafka redelivery, an operator's DLQ
// replay, the durable re-driver hours after the original event — describes the
// registry's opinion at an earlier moment and must not rewrite what a person
// decided. This predicate is the one place that rule lives; the projection
// consults it under the row lock.
// ══════════════════════════════════════════════════════════════════

export type VettingDimension = 'CRIMINAL' | 'ACADEMIC';

/** True when an officer has already decided `dimension` on this row. */
export function decidedByHuman(
  resolvedDimensions: readonly string[],
  dimension: 'AGE' | VettingDimension,
): boolean {
  return dimension !== 'AGE' && resolvedDimensions.includes(dimension);
}
