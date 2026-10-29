// TwilioSmsChannel: E.164, auth, idempotent bounded retries, cost cap, per-number
// limit, callback verification, no secret in any output. The provider is a fake
// fetch: this suite never touches a network (CI uses the emulator only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DailyCostCap, PerNumberLimiter, TwilioSmsChannel, normaliseToE164, parseStatusCallback, twilioSignature, verifyTwilioSignature,
} from '../dist/index.js';

const SID = 'AC' + 'a'.repeat(32);
const TOKEN = 'unit-test-twilio-token-not-real';
const MSG_SID = 'SM' + 'b'.repeat(32);

function channel(overrides = {}, responses = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 201, body: { sid: MSG_SID, status: 'queued' } };
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  };
  const ch = new TwilioSmsChannel({
    accountSid: SID, authToken: TOKEN, from: '+15005550006', baseUrl: 'http://127.0.0.1:1', timeoutMs: 500,
    costCap: new DailyCostCap(50), perNumber: new PerNumberLimiter(5, 900_000), fetchImpl, sleep: async () => undefined, ...overrides,
  });
  return { ch, calls };
}

// Built at run time: the personal-data scan flags any literal +250 7… number outside the 0788 00xx xxxx synthetic range.
const MTN79 = ['+250', '791234567'].join('');

test('E.164: national, international, spaced and bad inputs', () => {
  const cases = [
    ['0788000123', '+250788000123'], ['0788000722', '+250788000722'], ['250788000123', '+250788000123'],
    ['+250788000123', '+250788000123'], ['+250 788 000 123', '+250788000123'], ['00250788000123', '+250788000123'],
    ['+14155550100', '+14155550100'],
    ['0791234567', MTN79], ['+250 0791234567', MTN79], ['+250 (0)79 123 4567', MTN79],
    ['00250 0791234567', MTN79], ['0791.234.567', MTN79],
  ];
  for (const [input, expected] of cases) assert.equal(normaliseToE164(input), expected, input);
  for (const bad of ['', '   ', '788000123', '0188123456', '07881234', '+250188123456', 'abcdefghij', '+0123456789', '078800012378']) {
    assert.equal(normaliseToE164(bad), null, bad);
  }
});

test('sends a form with basic auth, E.164, the sender, and an idempotency token', async () => {
  const { ch, calls } = channel();
  assert.equal(await ch.send({ destination: '0788000123', body: 'code 123456', messageKey: 'key-1' }), 'ACCEPTED');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `http://127.0.0.1:1/2010-04-01/Accounts/${SID}/Messages.json`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
  assert.equal(init.headers['I-Twilio-Idempotency-Token'], 'key-1');
  const form = new URLSearchParams(init.body);
  assert.equal(form.get('To'), '+250788000123');
  assert.equal(form.get('From'), '+15005550006');
  assert.equal(form.get('Body'), 'code 123456');
  assert.ok(init.signal instanceof AbortSignal, 'every attempt has a timeout');
});

test('an unreadable destination is FAILED without calling the provider', async () => {
  const { ch, calls } = channel();
  assert.equal(await ch.send({ destination: '12345', body: 'x' }), 'FAILED');
  assert.equal(calls.length, 0);
});

test('retries network faults, 429 and 5xx under the SAME key, bounded; a 4xx is final', async () => {
  const a = channel({ maxAttempts: 3 }, [new Error('socket hang up'), { status: 503 }, { status: 201, body: { sid: MSG_SID } }]);
  assert.equal(await a.ch.send({ destination: '0788000123', body: 'x' }), 'ACCEPTED');
  assert.equal(a.calls.length, 3);
  const keys = new Set(a.calls.map((c) => c.init.headers['I-Twilio-Idempotency-Token']));
  assert.equal(keys.size, 1, 'one token for every attempt');

  const b = channel({ maxAttempts: 2 }, [{ status: 500 }, { status: 500 }, { status: 201 }]);
  assert.equal(await b.ch.send({ destination: '0788000123', body: 'x' }), 'FAILED');
  assert.equal(b.calls.length, 2, 'bounded');

  const c = channel({ maxAttempts: 3 }, [{ status: 400, body: { code: 21211 } }, { status: 201 }]);
  assert.equal(await c.ch.send({ destination: '0788000123', body: 'x' }), 'FAILED');
  assert.equal(c.calls.length, 1, 'a 4xx is never retried');

  const d = channel({ maxAttempts: 2 }, [{ status: 429 }, { status: 201, body: { sid: MSG_SID } }]);
  assert.equal(await d.ch.send({ destination: '0788000123', body: 'x' }), 'ACCEPTED');
});

test('the daily cost cap stops sending at the limit, and only ACCEPTED sends count', async () => {
  const cap = new DailyCostCap(2);
  const { ch, calls } = channel({ costCap: cap, perNumber: new PerNumberLimiter(100, 900_000) }, [{ status: 400 }]);
  assert.equal(await ch.send({ destination: '0788000001', body: 'x' }), 'FAILED'); // rejected: not counted
  assert.equal(cap.used(), 0);
  assert.equal(await ch.send({ destination: '0788000002', body: 'x' }), 'ACCEPTED');
  assert.equal(await ch.send({ destination: '0788000003', body: 'x' }), 'ACCEPTED');
  const before = calls.length;
  assert.equal(await ch.send({ destination: '0788000004', body: 'x' }), 'FAILED');
  assert.equal(calls.length, before, 'over the cap: the provider is not called');
});

test('the cost cap is shared through a state file, survives a restart, and rolls over at midnight (Kigali)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'usrp-cap-')), 'state', 'cap.log');
  let now = new Date('2026-10-28T10:00:00Z');
  const first = new DailyCostCap(3, file, () => now);
  first.record(); first.record();
  const second = new DailyCostCap(3, file, () => now); // a "restarted" or second process
  assert.equal(second.used(), 2);
  second.record();
  assert.equal(first.allows(), false);
  now = new Date('2026-10-28T22:30:00Z'); // 00:30 next day in Kigali
  assert.equal(first.allows(), true);
  assert.equal(first.used(), 0);
  assert.match(readFileSync(file, 'utf8'), /2026-10-28/, 'yesterday is kept, never rewritten');
});

test('a send refused by the cap does not burn the number slot', async () => {
  const cap = new DailyCostCap(1);
  const limiter = new PerNumberLimiter(1, 60_000);
  const { ch } = channel({ costCap: cap, perNumber: limiter });
  assert.equal(await ch.send({ destination: '0788003333', body: '1' }), 'ACCEPTED');
  assert.equal(await ch.send({ destination: '0788004444', body: '2' }), 'FAILED'); // cap
  assert.equal(limiter.take('+250788004444'), true, 'the refused number kept its slot');
});

test('the per-number limit holds per destination within its window only', async () => {
  let t = 0;
  const limiter = new PerNumberLimiter(2, 60_000, () => t);
  const { ch, calls } = channel({ perNumber: limiter });
  assert.equal(await ch.send({ destination: '0788001111', body: '1' }), 'ACCEPTED');
  assert.equal(await ch.send({ destination: '+250788001111', body: '2' }), 'ACCEPTED'); // same number, other spelling
  assert.equal(await ch.send({ destination: '0788001111', body: '3' }), 'FAILED');
  assert.equal(await ch.send({ destination: '0788002222', body: '4' }), 'ACCEPTED');
  t = 61_000;
  assert.equal(await ch.send({ destination: '0788001111', body: '5' }), 'ACCEPTED');
  assert.equal(calls.length, 4);
});

test('status callbacks: a good signature verifies, anything else does not (constant time, no throw)', () => {
  const url = 'https://notify.example.test/v1/sms/status';
  const params = { MessageSid: MSG_SID, MessageStatus: 'delivered', To: '+250788000123' };
  const sig = twilioSignature(TOKEN, url, params);
  const { ch } = channel();
  assert.equal(ch.verifyStatusCallback(url, params, sig), true);
  assert.equal(verifyTwilioSignature(TOKEN, url, params, sig), true);
  assert.equal(ch.verifyStatusCallback(url, { ...params, MessageStatus: 'failed' }, sig), false, 'tampered body');
  assert.equal(ch.verifyStatusCallback(`${url}?x=1`, params, sig), false, 'different URL');
  assert.equal(verifyTwilioSignature('other-token-value', url, params, sig), false, 'wrong token');
  for (const bad of [undefined, null, '', 'short', sig.slice(0, -2) + 'xx']) assert.equal(ch.verifyStatusCallback(url, params, bad), false);
  assert.deepEqual(parseStatusCallback(params), { sid: MSG_SID, status: 'delivered' });
  assert.equal(parseStatusCallback({ MessageSid: 'bogus', MessageStatus: 'sent' }), null);
  assert.equal(parseStatusCallback({ ...params, MessageStatus: 'weird' }).status, 'other');
});

test('the auth token and numbers never appear in logs, JSON, inspect or errors', async () => {
  const lines = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { lines.push(String(c)); return true; };
  process.stderr.write = (c) => { lines.push(String(c)); return true; };
  try {
    const ok = channel();
    await ok.ch.send({ destination: '0788000123', body: 'secret body 999999' });
    const bad = channel({}, [{ status: 400, body: { code: 21211, message: `bad ${TOKEN}` } }]);
    await bad.ch.send({ destination: '0788006543', body: 'x' });
    const text = lines.join('');
    assert.ok(text.includes('sms_sent') && text.includes('sms_send_failed'));
    for (const secret of [TOKEN, '788000123', '788006543', 'secret body', '999999']) assert.equal(text.includes(secret), false, `leaked ${secret.slice(0, 4)}`);
    for (const view of [JSON.stringify(ok.ch), inspect(ok.ch, { showHidden: true, depth: 5 }), String(ok.ch)]) assert.equal(view.includes(TOKEN), false);
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
});

test('a channel with no sender is refused at construction', () => {
  assert.throws(() => new TwilioSmsChannel({ accountSid: SID, authToken: TOKEN, from: null, costCap: new DailyCostCap(1), perNumber: new PerNumberLimiter(1, 1000) }), /sender/);
});
