// Boot guard: which SMS channel each runtime profile may wire (ADR-047 §3.1, S12b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogSmsChannel, TwilioSmsChannel, createSmsChannel } from '../dist/index.js';

const BASE = { consequence: 'no citizen could authenticate' };
const TWILIO = { TWILIO_ACCOUNT_SID: 'AC' + 'c'.repeat(32), TWILIO_AUTH_TOKEN: 'unit-test-twilio-token-not-real', TWILIO_FROM: '+15005550006' };
const SANDBOX = { NODE_ENV: 'production', USRP_ENVIRONMENT: 'sandbox' };
const throwsWith = (fn, re) => assert.throws(fn, (e) => re.test(e instanceof Error ? `${e.message} ${(e.issues ?? []).join(' ')}` : ''));

test('development without Twilio falls back to the dev log channel', () => {
  assert.ok(createSmsChannel({ ...BASE, source: { NODE_ENV: 'development' } }) instanceof LogSmsChannel);
});

test('LogSmsChannel stays refused in production and in the sandbox', () => {
  throwsWith(() => createSmsChannel({ ...BASE, source: { NODE_ENV: 'production' } }), /LogSmsChannel is a DEVELOPMENT adapter/);
  throwsWith(() => createSmsChannel({ ...BASE, source: SANDBOX }), /LogSmsChannel is a DEVELOPMENT adapter/);
});

test('TwilioSmsChannel is accepted in the sandbox (emulator) and in production', () => {
  const sandbox = createSmsChannel({ ...BASE, source: { ...SANDBOX, ...TWILIO, TWILIO_BASE_URL: 'http://localhost:4900' } });
  assert.ok(sandbox instanceof TwilioSmsChannel);
  const prod = createSmsChannel({ ...BASE, source: { NODE_ENV: 'production', ...TWILIO, SMS_DAILY_CAP: '500' } });
  assert.ok(prod instanceof TwilioSmsChannel);
});

test('the sandbox cannot reach the real API by accident', () => {
  throwsWith(() => createSmsChannel({ ...BASE, source: { ...SANDBOX, ...TWILIO } }), /emulator/);
  throwsWith(() => createSmsChannel({ ...BASE, source: { ...SANDBOX, ...TWILIO, TWILIO_BASE_URL: 'https://api.twilio.com' } }), /emulator/);
  throwsWith(() => createSmsChannel({ ...BASE, source: { ...SANDBOX, ...TWILIO, TWILIO_BASE_URL: 'https://example.org' } }), /emulator/);
  // The owner's opt-in permits Twilio's own host, and only that.
  assert.ok(createSmsChannel({ ...BASE, source: { ...SANDBOX, ...TWILIO, SANDBOX_SMS: 'twilio' } }) instanceof TwilioSmsChannel);
  throwsWith(() => createSmsChannel({ ...BASE, source: { ...SANDBOX, ...TWILIO, SANDBOX_SMS: 'twilio', TWILIO_BASE_URL: 'http://localhost:4900' } }), /api\.twilio\.com/);
});

test('a sender is required, the token is a secret, and production demands an explicit cap', () => {
  const { TWILIO_FROM: _from, ...noSender } = TWILIO;
  throwsWith(() => createSmsChannel({ ...BASE, source: { NODE_ENV: 'development', ...noSender } }), /TWILIO_FROM/);
  throwsWith(() => createSmsChannel({ ...BASE, source: { NODE_ENV: 'development', ...TWILIO, TWILIO_AUTH_TOKEN: 'short' } }), /TWILIO_AUTH_TOKEN/);
  throwsWith(() => createSmsChannel({ ...BASE, source: { NODE_ENV: 'production', ...TWILIO } }), /SMS_DAILY_CAP/);
  throwsWith(() => createSmsChannel({ ...BASE, source: { NODE_ENV: 'development', ...TWILIO, SMS_DAILY_CAP: '0' } }), /SMS_DAILY_CAP/);
});
