// ══════════════════════════════════════════════════════════════════
// identity-service — SmsChannel port (OTP delivery)
//
// Sends a one-time code to a raw phone number. The destination arrives
// from the live NIDA lookup and exists ONLY in memory on its way here —
// it is never persisted, never logged, never placed on the event bus.
// The adapter is the ONLY component that ever sees it (same contract as
// notification-service's NotificationChannel).
//
// Adapters: LogSmsChannel for dev (records what WOULD be sent, in-proc,
// for proofs; logs only a masked destination); a real MTN/Airtel SMS
// adapter is the flagged production follow-on shared with
// notification-service.
// ══════════════════════════════════════════════════════════════════

export type SmsDeliveryOutcome = 'SENT' | 'FAILED';

export interface OutboundSms {
  /** Raw destination phone — PII; never logged, never persisted. */
  readonly destination: string;
  readonly body: string;
}

export interface SmsChannel {
  send(message: OutboundSms): Promise<SmsDeliveryOutcome>;
}
