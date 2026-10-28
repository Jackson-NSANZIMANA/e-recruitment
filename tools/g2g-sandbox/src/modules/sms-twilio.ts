// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — sms-twilio: a Twilio-compatible Messages emulator
//
//   POST /2010-04-01/Accounts/{AccountSid}/Messages.json   (form-encoded)
//   GET  /2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json
//   Authorization: Basic base64(AccountSid:AuthToken)
//
// What it reproduces: the form API (To, From | MessagingServiceSid, Body,
// StatusCallback), message SIDs ("SM" + 32 hex), the 201 body, the error
// bodies ({code, message, more_info, status}), the status progression
// queued → sent → delivered | undelivered, signed status callbacks
// (X-Twilio-Signature: base64 HMAC-SHA1 over the URL plus the sorted
// key/value pairs), and an INBOX FILE (JSON lines {at, sid, destinationMasked,
// status, body}, mode 0600, the same masked shape as the dev inbox so the
// rehearsal reads an OTP from it unchanged).
//
// It NEVER sends anything anywhere except a status callback to a loopback
// URL (an emulator that posted to arbitrary hosts would be an SSRF tool).
//
// SANDBOX ASSUMPTIONS, to be confirmed by the owner's live SANDBOX_SMS=twilio
// check: the idempotency header name (I-Twilio-Idempotency-Token); the magic
// numbers below; the timing of the progression. Magic destinations (sandbox
// range only): +250788009990 → ends "undelivered" (30003), +250788009991 →
// refused 400 / 21610 (recipient opted out).
// ══════════════════════════════════════════════════════════════════

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SimRequest, SimResponse, SimulatorModule } from '../module.js';

export const TWILIO_MESSAGES_PATTERN = /^\/2010-04-01\/Accounts\/([A-Za-z0-9]{1,64})\/Messages\.json$/;
export const TWILIO_MESSAGE_PATTERN = /^\/2010-04-01\/Accounts\/([A-Za-z0-9]{1,64})\/Messages\/(SM[0-9a-f]{32})\.json$/;
export const TWILIO_IDEMPOTENCY_HEADER = 'i-twilio-idempotency-token';

/** Published development credentials; refused by main.ts in the sandbox profile. */
export const DEV_TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000dev';
export const DEV_TWILIO_AUTH_TOKEN = 'sandbox-dev-twilio-auth-token';

export const MAGIC_UNDELIVERED = '+250788009990';
export const MAGIC_OPTED_OUT = '+250788009991';

const E164 = /^\+[1-9][0-9]{7,14}$/;

export type TwilioStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

export interface EmulatedMessage {
  readonly sid: string;
  readonly accountSid: string;
  readonly to: string;
  readonly from: string | null;
  readonly messagingServiceSid: string | null;
  readonly body: string;
  readonly createdAt: number;
  readonly finalStatus: 'delivered' | 'undelivered';
}

export interface SmsTwilioOptions {
  readonly accountSid?: string;
  readonly authToken?: string;
  /** Append every message to this file (JSON lines, mode 0600). */
  readonly inboxFile?: string | null;
  readonly clock?: () => number;
  /** Time in the queued / sent states before the final status. */
  readonly queuedMs?: number;
  readonly sentMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface SmsTwilioModule extends SimulatorModule {
  /** Messages accepted this process (test inspection). */
  readonly messages: readonly EmulatedMessage[];
  /** How many repeat sends an idempotency token suppressed. */
  readonly duplicatesSuppressed: () => number;
}

export function twilioSignature(authToken: string, url: string, params: Readonly<Record<string, string>>): string {
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + (params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

function twilioError(status: number, code: number, message: string): SimResponse {
  return { status, json: { code, message, more_info: `https://www.twilio.com/docs/errors/${String(code)}`, status } };
}

function rfc2822(ms: number): string {
  return new Date(ms).toUTCString().replace('GMT', '+0000');
}

function basic(header: string | null): { user: string; pass: string } | null {
  const match = header === null ? null : /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
  if (match?.[1] === undefined) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? null : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createSmsTwilioModule(options: SmsTwilioOptions = {}): SmsTwilioModule {
  const accountSid = options.accountSid ?? DEV_TWILIO_ACCOUNT_SID;
  const authToken = options.authToken ?? DEV_TWILIO_AUTH_TOKEN;
  const clock = options.clock ?? Date.now;
  const queuedMs = options.queuedMs ?? 120;
  const sentMs = options.sentMs ?? 400;
  const fetchImpl = options.fetchImpl ?? fetch;
  const inbox = options.inboxFile === undefined || options.inboxFile === null || options.inboxFile.trim() === '' ? null : resolve(options.inboxFile);
  if (inbox !== null) mkdirSync(dirname(inbox), { recursive: true, mode: 0o700 });

  const messages: EmulatedMessage[] = [];
  const bySid = new Map<string, EmulatedMessage>();
  const byToken = new Map<string, EmulatedMessage>();
  let suppressed = 0;

  const statusOf = (m: EmulatedMessage): TwilioStatus => {
    const age = clock() - m.createdAt;
    if (age < queuedMs) return 'queued';
    if (age < queuedMs + sentMs) return 'sent';
    return m.finalStatus;
  };

  const render = (m: EmulatedMessage): Record<string, unknown> => {
    const status = statusOf(m);
    const failed = status === 'undelivered';
    return {
      account_sid: m.accountSid,
      api_version: '2010-04-01',
      body: m.body,
      date_created: rfc2822(m.createdAt),
      date_sent: status === 'queued' ? null : rfc2822(m.createdAt + queuedMs),
      date_updated: rfc2822(Math.min(clock(), m.createdAt + queuedMs + sentMs)),
      direction: 'outbound-api',
      error_code: failed ? 30003 : null,
      error_message: failed ? 'Unreachable destination handset' : null,
      from: m.from,
      messaging_service_sid: m.messagingServiceSid,
      num_media: '0',
      num_segments: '1',
      price: null,
      price_unit: 'USD',
      sid: m.sid,
      status,
      subresource_uris: { media: `/2010-04-01/Accounts/${m.accountSid}/Messages/${m.sid}/Media.json` },
      to: m.to,
      uri: `/2010-04-01/Accounts/${m.accountSid}/Messages/${m.sid}.json`,
    };
  };

  const writeInbox = (m: EmulatedMessage): void => {
    if (inbox === null) return;
    const line = JSON.stringify({ at: new Date(m.createdAt).toISOString(), sid: m.sid, destinationMasked: `***${m.to.slice(-2)}`, body: m.body });
    appendFileSync(inbox, `${line}\n`, { mode: 0o600 });
  };

  const callbackTo = (url: string, m: EmulatedMessage, status: TwilioStatus): void => {
    const params: Record<string, string> = {
      AccountSid: m.accountSid, ApiVersion: '2010-04-01', From: m.from ?? '', MessageSid: m.sid, MessageStatus: status,
      MessagingServiceSid: m.messagingServiceSid ?? '', SmsSid: m.sid, SmsStatus: status, To: m.to,
    };
    const signature = twilioSignature(authToken, url, params);
    void fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      body: new URLSearchParams(params).toString(),
      redirect: 'manual', // a loopback listener must not bounce the signed POST elsewhere
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
  };

  const authorizeRequest = (req: SimRequest, sidInPath: string): SimResponse | null => {
    const creds = basic(req.header('authorization'));
    if (creds === null || !safeEqual(creds.user, accountSid) || !safeEqual(creds.pass, authToken) || sidInPath !== accountSid) {
      return twilioError(401, 20003, 'Authenticate');
    }
    return null;
  };

  const pathSid = (path: string): string => TWILIO_MESSAGES_PATTERN.exec(path)?.[1] ?? TWILIO_MESSAGE_PATTERN.exec(path)?.[1] ?? '';

  return {
    id: 'sms-twilio',
    authority: 'sms',
    messages,
    duplicatesSuppressed: () => suppressed,
    matches: (method, path) => (method === 'POST' && TWILIO_MESSAGES_PATTERN.test(path)) || (method === 'GET' && TWILIO_MESSAGE_PATTERN.test(path)),
    authorize(req): { readonly client: string } | SimResponse {
      const refusal = authorizeRequest(req, pathSid(req.path));
      return refusal ?? { client: 'account' };
    },
    subject: () => null,
    fault(kind): SimResponse {
      if (kind === 'rate-limited') return twilioError(429, 20429, 'Too Many Requests');
      if (kind === 'maintenance') return twilioError(503, 20503, 'Service Unavailable');
      return twilioError(500, 20500, 'Internal Server Error');
    },
    async handle(req): Promise<SimResponse> {
      const sid = pathSid(req.path);
      if (req.method === 'GET') {
        const found = bySid.get(TWILIO_MESSAGE_PATTERN.exec(req.path)?.[2] ?? '');
        return found === undefined ? twilioError(404, 20404, 'The requested resource was not found') : { status: 200, json: render(found) };
      }
      const form = new URLSearchParams((await req.body()).toString('utf8'));
      const to = form.get('To')?.trim() ?? '';
      const from = form.get('From')?.trim() ?? '';
      const service = form.get('MessagingServiceSid')?.trim() ?? '';
      const body = form.get('Body') ?? '';
      const callback = form.get('StatusCallback')?.trim() ?? '';
      if (!E164.test(to)) return twilioError(400, 21211, "The 'To' number is not a valid phone number.");
      if (from === '' && service === '') return twilioError(400, 21603, "A 'From' or 'MessagingServiceSid' parameter is required.");
      if (from !== '' && !E164.test(from)) return twilioError(400, 21212, "The 'From' number is not a valid phone number, shortcode, or alphanumeric sender ID.");
      if (body.trim() === '') return twilioError(400, 21602, 'Message body is required.');
      if (to === MAGIC_OPTED_OUT) return twilioError(400, 21610, 'Attempt to send to unsubscribed recipient');

      const token = req.header(TWILIO_IDEMPOTENCY_HEADER)?.trim() ?? '';
      if (token !== '') {
        const previous = byToken.get(`${sid}\u0000${token}`);
        if (previous !== undefined) {
          suppressed += 1;
          return { status: 201, json: render(previous) };
        }
      }
      const message: EmulatedMessage = {
        sid: `SM${randomBytes(16).toString('hex')}`, accountSid: sid, to, from: from === '' ? null : from,
        messagingServiceSid: service === '' ? null : service, body, createdAt: clock(),
        finalStatus: to === MAGIC_UNDELIVERED ? 'undelivered' : 'delivered',
      };
      messages.push(message);
      bySid.set(message.sid, message);
      if (token !== '') byToken.set(`${sid}\u0000${token}`, message);
      writeInbox(message);
      if (callback !== '' && isLoopbackUrl(callback)) {
        setTimeout(() => { callbackTo(callback, message, 'sent'); }, queuedMs).unref();
        setTimeout(() => { callbackTo(callback, message, message.finalStatus); }, queuedMs + sentMs).unref();
      }
      return { status: 201, json: render(message) };
    },
  };
}
