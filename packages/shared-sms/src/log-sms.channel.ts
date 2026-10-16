// ══════════════════════════════════════════════════════════════════
// shared-sms — LogSmsChannel adapter (dev/proof SMS channel)
//
// The dev-tier SmsChannel: no telecom integration exists yet, so this
// records each message in-process (selfchecks read `sent` to close their
// loops without a phone) and logs ONE masked line — last two digits of
// the destination, never the body (OTP bodies contain the code).
// Production swaps in a real MTN/Airtel adapter behind the same port.
//
// DEV INBOX (opt-in). With `inboxFile`, each message is ALSO appended to
// that file as one JSON line, so a developer can complete citizen sign-in
// in a browser — the OTP is otherwise unreadable outside this process.
// The log line stays masked; only the owner-readable (0600) file holds the
// body. Production cannot reach this: every service that constructs a
// LogSmsChannel first calls assertDevAdapterAllowed, which refuses to
// boot under NODE_ENV=production.
// ══════════════════════════════════════════════════════════════════

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logInfo } from '@usrp/shared-logging';
import type { OutboundSms, SmsChannel, SmsDeliveryOutcome } from './sms-channel.js';

export interface LogSmsChannelOptions {
  /** Dev only: append every message to this file (JSON lines). Absent or empty = off. */
  readonly inboxFile?: string | undefined;
}

export class LogSmsChannel implements SmsChannel {
  /** Messages "sent" this process — for dev inspection and proofs only. */
  readonly sent: OutboundSms[] = [];
  /** Absolute path of the dev inbox, or null when it is off. */
  readonly inboxFile: string | null;

  constructor(options: LogSmsChannelOptions = {}) {
    const requested = options.inboxFile?.trim() ?? '';
    this.inboxFile = requested === '' ? null : resolve(requested);
    if (this.inboxFile !== null) {
      mkdirSync(dirname(this.inboxFile), { recursive: true, mode: 0o700 });
      logInfo('dev_sms_inbox_enabled', { channel: 'LOG', inboxFile: this.inboxFile });
    }
  }

  send(message: OutboundSms): Promise<SmsDeliveryOutcome> {
    this.sent.push(message);
    const destinationMasked = `***${message.destination.slice(-2)}`;
    logInfo('sms_would_send', {
      channel: 'LOG',
      // Masked: enough to eyeball dev flows, useless to an attacker.
      destinationMasked,
      bodyLength: message.body.length,
    });
    if (this.inboxFile !== null) {
      const line = JSON.stringify({ at: new Date().toISOString(), destinationMasked, body: message.body });
      appendFileSync(this.inboxFile, `${line}\n`, { mode: 0o600 });
    }
    return Promise.resolve('ACCEPTED');
  }
}
