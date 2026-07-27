// ══════════════════════════════════════════════════════════════════
// shared-sms — the one SMS channel port (ADR-021)
//
// Sends a message to a raw phone number. The destination exists ONLY in
// memory on its way here (identity-service: live NIDA lookup for the OTP;
// notification-service: PgContactResolver decrypt for the invitation) —
// it is never persisted by the channel, never logged, never placed on the
// event bus. The adapter is the ONLY component that ever sees it.
//
// This port unifies the two pre-ADR-021 per-service ports (identity's
// SmsChannel and notification's NotificationChannel), so the real
// MTN/Airtel adapter — the flagged production follow-on, blocked on a
// telecom contract — lands exactly once for both services.
// ══════════════════════════════════════════════════════════════════

/**
 * Transport truth only: the gateway ACCEPTED the message or it FAILED.
 * Nobody at this layer knows the handset received it — delivery receipts
 * are a provider follow-on. (The pre-unification ports' 'SENT' and
 * 'DELIVERED' literals overclaimed; consumers map ACCEPTED to their own
 * domain literals.)
 */
export type SmsDeliveryOutcome = 'ACCEPTED' | 'FAILED';

export interface OutboundSms {
  /** Raw destination phone — PII; never logged, never persisted. */
  readonly destination: string;
  readonly body: string;
}

export interface SmsChannel {
  send(message: OutboundSms): Promise<SmsDeliveryOutcome>;
}
