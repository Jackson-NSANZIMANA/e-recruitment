// ══════════════════════════════════════════════════════════════════
// shared-sms — composition helper: pick the SMS channel for this process
//
//   TWILIO_ACCOUNT_SID set  → TwilioSmsChannel, configured from the env
//                             (the auth token is a production-guard secret).
//   otherwise               → LogSmsChannel, past assertDevAdapterAllowed,
//                             which REFUSES it in sandbox and production:
//                             a log line is not delivery, so no citizen could
//                             sign in behind green healthchecks.
//
// Fences (ADR-047 §3.1) for the Twilio channel:
//   sandbox    TWILIO_BASE_URL is REQUIRED and must be the emulator (a
//              simulator host or loopback), unless the owner opted in with
//              SANDBOX_SMS=twilio, in which case it must be api.twilio.com.
//              A sandbox therefore cannot send a real SMS by accident.
//   production a simulator host is refused (sandbox-fence.ts).
//
// Env:  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (secret), TWILIO_FROM or
//       TWILIO_MESSAGING_SERVICE_SID, TWILIO_BASE_URL, TWILIO_TIMEOUT_MS (8000),
//       TWILIO_STATUS_CALLBACK_URL, SMS_DAILY_CAP (default 50 in development
//       and sandbox; REQUIRED in production), SMS_CAP_STATE_FILE (shared
//       counter file), SMS_PER_NUMBER_MAX (5), SMS_PER_NUMBER_WINDOW_SECONDS (900).
// ══════════════════════════════════════════════════════════════════

import {
  assertDevAdapterAllowed,
  EnvValidationError,
  integer,
  isSimulatorHost,
  loadEnv,
  optional,
  resolveUsrpEnvironment,
  string,
  url,
  withDefault,
  type EnvSource,
} from '@usrp/shared-config';
import { LogSmsChannel } from './log-sms.channel.js';
import { normaliseToE164 } from './phone.js';
import type { OutboundSms, SmsChannel, SmsDeliveryOutcome } from './sms-channel.js';
import { DailyCostCap, PerNumberLimiter } from './twilio-guards.js';
import { TwilioSmsChannel } from './twilio-sms.channel.js';

/** Sandbox default (owner decision 2026-10-28, default taken, owner to confirm). */
export const DEFAULT_SANDBOX_DAILY_SMS_CAP = 50;

export interface CreateSmsChannelOptions {
  /** What silently breaks if the dev channel were allowed, for the operator. */
  readonly consequence: string;
  readonly source?: EnvSource;
  /** Dev inbox for LogSmsChannel (development only). */
  readonly devInboxFile?: string | undefined;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

function hostOf(raw: string): string {
  return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function createSmsChannel(options: CreateSmsChannelOptions): SmsChannel {
  const source = options.source ?? process.env;
  const environment = resolveUsrpEnvironment(source);
  if ((source['TWILIO_ACCOUNT_SID'] ?? '').trim() === '') {
    assertDevAdapterAllowed('LogSmsChannel', options.consequence, source);
    return new LogSmsChannel({ inboxFile: options.devInboxFile });
  }

  const env = loadEnv(
    {
      TWILIO_ACCOUNT_SID: string({ minLength: 10 }),
      TWILIO_AUTH_TOKEN: string({ minLength: 8, secret: true }),
      TWILIO_FROM: optional(string()),
      TWILIO_MESSAGING_SERVICE_SID: optional(string()),
      TWILIO_BASE_URL: optional(url({ protocols: ['http', 'https'] })),
      TWILIO_TIMEOUT_MS: withDefault(integer({ min: 500, max: 60_000 }), 8000),
      TWILIO_STATUS_CALLBACK_URL: optional(url({ protocols: ['http', 'https'] })),
      SMS_DAILY_CAP: environment === 'production' ? integer({ min: 1, max: 1_000_000 }) : withDefault(integer({ min: 1, max: 1_000_000 }), DEFAULT_SANDBOX_DAILY_SMS_CAP),
      SMS_CAP_STATE_FILE: optional(string()),
      SMS_PER_NUMBER_MAX: withDefault(integer({ min: 1, max: 100 }), 5),
      SMS_PER_NUMBER_WINDOW_SECONDS: withDefault(integer({ min: 1, max: 86_400 }), 900),
    },
    source,
  );
  const issues: string[] = [];
  if ((env.TWILIO_FROM ?? '') === '' && (env.TWILIO_MESSAGING_SERVICE_SID ?? '') === '') {
    issues.push('TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID is required.');
  }
  let allowed: ReadonlySet<string> | null = null;
  if (environment === 'sandbox') {
    const live = (source['SANDBOX_SMS'] ?? '').trim().toLowerCase() === 'twilio';
    if (live) {
      // A real send in the sandbox reaches only the owner's verified numbers: the synthetic
      // population's numbers are well-formed Rwandan numbers that may belong to real people.
      const list = (source['SANDBOX_SMS_ALLOWED_TO'] ?? '').split(',').map((n) => normaliseToE164(n.trim()));
      if (list.length === 0 || list.some((n) => n === null)) issues.push('SANDBOX_SMS=twilio needs SANDBOX_SMS_ALLOWED_TO: the owner\'s verified numbers, comma-separated, each a valid phone number.');
      else allowed = new Set(list as string[]);
    }
    const base = env.TWILIO_BASE_URL;
    if (live) {
      if (base !== undefined && hostOf(base) !== 'api.twilio.com') issues.push('SANDBOX_SMS=twilio sends through api.twilio.com; TWILIO_BASE_URL must be unset or that host.');
    } else if (base === undefined || !(isSimulatorHost(hostOf(base)) || LOOPBACK.has(hostOf(base)))) {
      issues.push('In the sandbox TWILIO_BASE_URL must name the Twilio emulator; a real send needs the owner opt-in SANDBOX_SMS=twilio.');
    }
  }
  // The counter must survive a restart and be shared by the services (a crash loop must
  // not reset a cost cap): outside development the state file is required.
  if (environment !== 'development' && (env.SMS_CAP_STATE_FILE ?? '').trim() === '') {
    issues.push('SMS_CAP_STATE_FILE is required in the sandbox and production: the daily cost cap must survive a restart.');
  }
  if (issues.length > 0) throw new EnvValidationError(issues);

  const stateFile = (env.SMS_CAP_STATE_FILE ?? '').trim();
  const twilio = new TwilioSmsChannel({
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    from: (env.TWILIO_FROM ?? '') === '' ? null : (env.TWILIO_FROM ?? null),
    messagingServiceSid: (env.TWILIO_MESSAGING_SERVICE_SID ?? '') === '' ? null : (env.TWILIO_MESSAGING_SERVICE_SID ?? null),
    ...(env.TWILIO_BASE_URL === undefined ? {} : { baseUrl: env.TWILIO_BASE_URL }),
    timeoutMs: env.TWILIO_TIMEOUT_MS,
    statusCallbackUrl: env.TWILIO_STATUS_CALLBACK_URL ?? null,
    costCap: new DailyCostCap(env.SMS_DAILY_CAP, stateFile === '' ? null : stateFile),
    perNumber: new PerNumberLimiter(env.SMS_PER_NUMBER_MAX, env.SMS_PER_NUMBER_WINDOW_SECONDS * 1000),
  });
  return allowed === null ? twilio : new AllowlistSmsChannel(twilio, allowed);
}

/**
 * Refuses, before the provider is called, every destination outside the allowlist.
 * FAILED is the transport truth for a message that was never handed to the gateway.
 */
export class AllowlistSmsChannel implements SmsChannel {
  readonly #inner: SmsChannel;
  readonly #allowed: ReadonlySet<string>;

  constructor(inner: SmsChannel, allowed: ReadonlySet<string>) {
    this.#inner = inner;
    this.#allowed = allowed;
  }

  async send(message: OutboundSms): Promise<SmsDeliveryOutcome> {
    const destination = normaliseToE164(message.destination);
    if (destination === null || !this.#allowed.has(destination)) return 'FAILED';
    return this.#inner.send(message);
  }
}
