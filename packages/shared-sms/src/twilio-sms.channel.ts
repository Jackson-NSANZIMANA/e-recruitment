// ══════════════════════════════════════════════════════════════════
// shared-sms — TwilioSmsChannel (the sandbox operator; ADR-047 §3.2)
//
//   POST {base}/2010-04-01/Accounts/{AccountSid}/Messages.json
//   Authorization: Basic base64(AccountSid:AuthToken)
//   form: To (E.164), From | MessagingServiceSid, Body, [StatusCallback]
//   I-Twilio-Idempotency-Token: the message key (same on every retry)
//
// What it guarantees
//   • numbers are normalised to E.164 (07XXXXXXXX → +2507XXXXXXXX); one that
//     cannot be read is FAILED, never guessed;
//   • a per-number rate limit and a per-day COST CAP stop a loop or an abuse
//     from becoming a bill; both answer FAILED and log without any number;
//   • a timeout on every attempt; a network fault, a timeout, 429 and 5xx are
//     retried (bounded) under the SAME idempotency token, so a lost response
//     cannot send twice; a 4xx is final;
//   • the auth token lives in a private field: not in logs, errors, JSON or
//     util.inspect output;
//   • status callbacks are verified with X-Twilio-Signature in constant time.
//
// ACCEPTED means the provider took the message ("queued"), nothing more: the
// SmsChannel port reports transport truth only (sms-channel.ts).
// ══════════════════════════════════════════════════════════════════

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { logError, logInfo } from '@usrp/shared-logging';
import { maskDestination, normaliseToE164 } from './phone.js';
import type { OutboundSms, SmsChannel, SmsDeliveryOutcome } from './sms-channel.js';
import type { DailyCostCap, PerNumberLimiter } from './twilio-guards.js';

export const TWILIO_IDEMPOTENCY_HEADER = 'I-Twilio-Idempotency-Token';

export interface TwilioSmsChannelOptions {
  readonly accountSid: string;
  /** Secret. Held privately; never logged. */
  readonly authToken: string;
  /** E.164 sender, or null when a messaging service is used. */
  readonly from: string | null;
  readonly messagingServiceSid?: string | null;
  /** Default https://api.twilio.com; the sandbox points it at the emulator. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Total attempts including the first. Default 2. */
  readonly maxAttempts?: number;
  readonly statusCallbackUrl?: string | null;
  readonly costCap: DailyCostCap;
  readonly perNumber: PerNumberLimiter;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Twilio's request-validation signature: base64 HMAC-SHA1 over the URL plus the sorted key+value pairs. */
export function twilioSignature(authToken: string, url: string, params: Readonly<Record<string, string>>): string {
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + (params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function verifyTwilioSignature(authToken: string, url: string, params: Readonly<Record<string, string>>, header: string | null | undefined): boolean {
  if (header === undefined || header === null || header === '') return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type TwilioDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed' | 'other';

/** The two fields of a status callback the platform may keep. */
export function parseStatusCallback(params: Readonly<Record<string, string>>): { readonly sid: string; readonly status: TwilioDeliveryStatus } | null {
  const sid = params['MessageSid'] ?? params['SmsSid'] ?? '';
  const raw = params['MessageStatus'] ?? params['SmsStatus'] ?? '';
  if (!/^SM[0-9a-f]{32}$/.test(sid)) return null;
  const known: readonly string[] = ['queued', 'sent', 'delivered', 'undelivered', 'failed'];
  return { sid, status: (known.includes(raw) ? raw : 'other') as TwilioDeliveryStatus };
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export class TwilioSmsChannel implements SmsChannel {
  readonly #accountSid: string;
  readonly #authToken: string;
  readonly #from: string | null;
  readonly #service: string | null;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #attempts: number;
  readonly #callback: string | null;
  readonly #cap: DailyCostCap;
  readonly #limiter: PerNumberLimiter;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: TwilioSmsChannelOptions) {
    if (options.from === null && (options.messagingServiceSid ?? null) === null) {
      throw new Error('TwilioSmsChannel needs a sender: TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID.');
    }
    this.#accountSid = options.accountSid;
    this.#authToken = options.authToken;
    this.#from = options.from;
    this.#service = options.messagingServiceSid ?? null;
    this.#base = (options.baseUrl ?? 'https://api.twilio.com').replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 8000;
    this.#attempts = Math.max(1, options.maxAttempts ?? 2);
    this.#callback = options.statusCallbackUrl ?? null;
    this.#cap = options.costCap;
    this.#limiter = options.perNumber;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? sleepFor;
  }

  /** Verify an inbound status callback for the URL Twilio was given. */
  verifyStatusCallback(url: string, params: Readonly<Record<string, string>>, signatureHeader: string | null | undefined): boolean {
    return verifyTwilioSignature(this.#authToken, url, params, signatureHeader);
  }

  toJSON(): { channel: 'TWILIO' } {
    return { channel: 'TWILIO' };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'TwilioSmsChannel { credentials: [redacted] }';
  }

  async send(message: OutboundSms): Promise<SmsDeliveryOutcome> {
    const to = normaliseToE164(message.destination);
    if (to === null) {
      logError('sms_destination_unreadable', { channel: 'TWILIO' });
      return 'FAILED';
    }
    // The cap first: a send refused by the cap must not burn the number's slot.
    if (!this.#cap.allows()) {
      logError('sms_cost_cap_reached', { channel: 'TWILIO', limit: this.#cap.limit });
      return 'FAILED';
    }
    if (!this.#limiter.take(to)) {
      logError('sms_number_rate_limited', { channel: 'TWILIO', destinationMasked: maskDestination(to) });
      return 'FAILED';
    }

    const form = new URLSearchParams({ To: to, Body: message.body });
    if (this.#from !== null) form.set('From', this.#from);
    if (this.#service !== null) form.set('MessagingServiceSid', this.#service);
    if (this.#callback !== null) form.set('StatusCallback', this.#callback);
    const key = message.messageKey ?? randomUUID();
    const url = `${this.#base}/2010-04-01/Accounts/${encodeURIComponent(this.#accountSid)}/Messages.json`;
    const authorization = `Basic ${Buffer.from(`${this.#accountSid}:${this.#authToken}`).toString('base64')}`;

    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      let response: Response | null = null;
      try {
        response = await this.#fetch(url, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', [TWILIO_IDEMPOTENCY_HEADER]: key },
          body: form.toString(),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch {
        response = null; // network fault or timeout: retryable under the same key
      }
      if (response !== null && response.status >= 200 && response.status < 300) {
        const sid = await readSid(response);
        this.#cap.record();
        logInfo('sms_sent', { channel: 'TWILIO', destinationMasked: maskDestination(to), bodyLength: message.body.length, ...(sid === null ? {} : { sid }) });
        return 'ACCEPTED';
      }
      const retryable = response === null || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === this.#attempts) {
        const code = response === null ? null : await readCode(response);
        logError('sms_send_failed', { channel: 'TWILIO', destinationMasked: maskDestination(to), httpStatus: response?.status ?? 0, ...(code === null ? {} : { providerCode: code }), attempt });
        return 'FAILED';
      }
      await this.#sleep(250 * 2 ** (attempt - 1));
    }
    return 'FAILED';
  }
}

async function readSid(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { sid?: unknown };
    return typeof body.sid === 'string' && /^SM[0-9a-f]{32}$/.test(body.sid) ? body.sid : null;
  } catch {
    return null;
  }
}

async function readCode(response: Response): Promise<number | null> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === 'number' ? body.code : null;
  } catch {
    return null;
  }
}
