// ══════════════════════════════════════════════════════════════════
// @usrp/shared-events — Topic routing & partition keying
//
// The event→topic map is exhaustive over USRPEvent['eventType']: adding a
// new event type to @usrp/shared-types without routing it here is a
// compile error, not a silent runtime drop.
// ══════════════════════════════════════════════════════════════════

import { KAFKA_TOPICS, type KafkaTopic, type USRPEvent } from '@usrp/shared-types';

type EventType = USRPEvent['eventType'];

const EVENT_TYPE_TO_TOPIC: Readonly<Record<EventType, KafkaTopic>> = {
  APPLICANT_SUBMITTED: KAFKA_TOPICS.APPLICANT_SUBMITTED,
  NIDA_VERIFICATION_COMPLETED: KAFKA_TOPICS.VETTING_NIDA,
  NESA_VERIFICATION_COMPLETED: KAFKA_TOPICS.VETTING_NESA,
  HEC_VERIFICATION_COMPLETED: KAFKA_TOPICS.VETTING_HEC,
  RIB_VETTING_COMPLETED: KAFKA_TOPICS.VETTING_RIB,
  AGE_ELIGIBILITY_COMPLETED: KAFKA_TOPICS.VETTING_AGE,
  APPLICATION_ELIGIBILITY_CLEARED: KAFKA_TOPICS.APPLICATION_CLEARED,
  BIOMETRIC_VERIFICATION_COMPLETED: KAFKA_TOPICS.BIOMETRIC_RESULT,
  SLOT_ASSIGNED: KAFKA_TOPICS.SLOT_ASSIGNED,
  FIELD_SCORE_CAPTURED: KAFKA_TOPICS.FIELD_SCORE_CAPTURED,
  NOTIFICATION_DELIVERED: KAFKA_TOPICS.NOTIFICATION_DELIVERED,
  DOCUMENT_FORENSICS_COMPLETED: KAFKA_TOPICS.DOCUMENT_FORENSICS,
  AUDIT_ENTRY: KAFKA_TOPICS.AUDIT_IMMUTABLE,
} as const;

export function topicForEvent(event: USRPEvent): KafkaTopic {
  return EVENT_TYPE_TO_TOPIC[event.eventType];
}

/**
 * Partition key: all events about the same applicant (or, failing that,
 * the same application/entity) route to the same partition, preserving
 * per-applicant ordering across the vetting pipeline.
 */
export function partitionKeyForEvent(event: USRPEvent): string {
  const fallback = event.eventId; // base field, present on every event
  if ('applicantId' in event) return event.applicantId;
  if ('applicationId' in event) return event.applicationId;
  if ('entityId' in event) return event.entityId;
  return fallback;
}
