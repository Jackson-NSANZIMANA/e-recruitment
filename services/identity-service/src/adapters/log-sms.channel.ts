// ══════════════════════════════════════════════════════════════════
// identity-service — LogSmsChannel adapter (dev/proof SMS channel)
//
// The dev-tier SmsChannel: no telecom integration exists yet, so this
// records each message in-process (the selfcheck reads `sent` to close
// the OTP loop without a phone) and logs ONE masked line — last two
// digits of the destination, never the body (the body contains the code).
// Production swaps in a real MTN/Airtel adapter behind the same port.
// ══════════════════════════════════════════════════════════════════

import type { OutboundSms, SmsChannel, SmsDeliveryOutcome } from '../ports/sms-channel.js';

export class LogSmsChannel implements SmsChannel {
  /** Messages "sent" this process — for dev inspection and proofs only. */
  readonly sent: OutboundSms[] = [];

  async send(message: OutboundSms): Promise<SmsDeliveryOutcome> {
    this.sent.push(message);
    console.log(
      JSON.stringify({
        msg: 'sms_would_send',
        channel: 'LOG',
        // Masked: enough to eyeball dev flows, useless to an attacker.
        destinationMasked: `***${message.destination.slice(-2)}`,
        bodyLength: message.body.length,
      }),
    );
    return 'SENT';
  }
}
