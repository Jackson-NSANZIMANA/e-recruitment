// ══════════════════════════════════════════════════════════════════
// notification-service — NotificationChannel port
//
// Sends a rendered message to a resolved destination. Adapters: a log/mock
// channel for dev (records what WOULD be sent), and — later — real SMS
// (MTN/Airtel) / SMTP adapters. The channel is the ONLY component that ever
// sees the raw destination; it must not log the destination or the body.
// ══════════════════════════════════════════════════════════════════

export type DeliveryOutcome = 'DELIVERED' | 'FAILED';

export interface OutboundMessage {
  readonly channel: 'SMS' | 'EMAIL';
  /** PII destination — provided by the ContactResolver, never logged. */
  readonly destination: string;
  readonly body: string;
}

export interface NotificationChannel {
  send(message: OutboundMessage): Promise<DeliveryOutcome>;
}
