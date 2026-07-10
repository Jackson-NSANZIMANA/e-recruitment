// ══════════════════════════════════════════════════════════════════
// notification-service — NotificationChannel adapter (dev log/mock)
//
// The dev channel: it does NOT hit a real SMS/email provider. It records that
// a message WOULD have been sent (for proofs) and logs a REDACTED line — never
// the destination, never the body (both may carry PII / the QR credential).
// Real MTN/Airtel-SMS and SMTP adapters replace this behind the same port.
// ══════════════════════════════════════════════════════════════════

import type { DeliveryOutcome, NotificationChannel, OutboundMessage } from '../ports/notification-channel.js';

export class LogChannel implements NotificationChannel {
  /** In-memory record of sends, for the selfcheck to inspect. */
  readonly sent: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<DeliveryOutcome> {
    this.sent.push(message);
    // Redacted: channel + destination length only — never the value or body.
    console.log(
      JSON.stringify({
        msg: 'notification_channel_send',
        channel: message.channel,
        destinationLength: message.destination.length,
      }),
    );
    return 'DELIVERED';
  }
}
