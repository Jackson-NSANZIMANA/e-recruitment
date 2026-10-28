import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxServer } from '../src/server.js';
import { DEFAULT_PROFILES, type AuthorityProfile } from '../src/behaviour.js';
import { buildModules } from '../src/modules/index.js';
import { createSmsTwilioModule, DEV_TWILIO_ACCOUNT_SID, DEV_TWILIO_AUTH_TOKEN, MAGIC_OPTED_OUT, MAGIC_UNDELIVERED, twilioSignature } from '../src/modules/sms-twilio.js';
import type { Authority } from '../src/population/model.js';
import { captureLog, population, TOKEN } from './helpers.js';

const GENEROUS = Object.fromEntries(Object.entries(DEFAULT_PROFILES).map(([k, v]) => [k, { ...v, bucketCapacity: 10_000 }])) as Record<Authority, AuthorityProfile>;
const AUTH = `Basic ${Buffer.from(`${DEV_TWILIO_ACCOUNT_SID}:${DEV_TWILIO_AUTH_TOKEN}`).toString('base64')}`;
const PATH = `/2010-04-01/Accounts/${DEV_TWILIO_ACCOUNT_SID}/Messages.json`;

async function start(sms: Parameters<typeof createSmsTwilioModule>[0] = {}) {
  const module = createSmsTwilioModule(sms);
  const server = await createSandboxServer({
    world: { population: population(5), overlay: null, live: null, now: () => new Date(), log: captureLog().log, clientTokens: new Set([TOKEN]) },
    environment: 'development', port: 0, host: '127.0.0.1', latencyScale: 0, profiles: GENEROUS,
    modules: [...buildModules().filter((m) => m.id !== 'sms-twilio'), module],
  });
  return { server, module };
}
const send = (base: string, form: Record<string, string>, headers: Record<string, string> = {}, auth: string | null = AUTH) =>
  fetch(`${base}${PATH}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(auth === null ? {} : { authorization: auth }), ...headers }, body: new URLSearchParams(form).toString() });

test('accepts the form API and answers the 201 body with an SM sid and queued status', async () => {
  const { server } = await start();
  try {
    const r = await send(server.url, { To: '+250788000160', From: '+15005550006', Body: 'code 123456' });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-usrp-sandbox'), '1');
    const m = (await r.json()) as Record<string, unknown>;
    assert.match(String(m['sid']), /^SM[0-9a-f]{32}$/);
    assert.equal(m['status'], 'queued');
    assert.equal(m['direction'], 'outbound-api');
    assert.equal(m['api_version'], '2010-04-01');
  } finally { await server.stop(); }
});

test('status progresses queued → sent → delivered (and → undelivered for the magic number)', async () => {
  let now = 1_000_000;
  const { server } = await start({ clock: () => now, queuedMs: 100, sentMs: 300 });
  try {
    const ok = (await (await send(server.url, { To: '+250788000161', From: '+15005550006', Body: 'x' })).json()) as { sid: string };
    const bad = (await (await send(server.url, { To: MAGIC_UNDELIVERED, From: '+15005550006', Body: 'x' })).json()) as { sid: string };
    const status = async (sid: string): Promise<string> => ((await (await fetch(`${server.url}/2010-04-01/Accounts/${DEV_TWILIO_ACCOUNT_SID}/Messages/${sid}.json`, { headers: { authorization: AUTH } })).json()) as { status: string }).status;
    assert.equal(await status(ok.sid), 'queued');
    now += 150;
    assert.equal(await status(ok.sid), 'sent');
    now += 400;
    assert.equal(await status(ok.sid), 'delivered');
    assert.equal(await status(bad.sid), 'undelivered');
  } finally { await server.stop(); }
});

test('refuses bad credentials, a wrong account in the path, invalid numbers and missing fields in Twilio error bodies', async () => {
  const { server } = await start();
  try {
    const noAuth = await send(server.url, { To: '+250788000160', From: '+15005550006', Body: 'x' }, {}, null);
    assert.equal(noAuth.status, 401);
    assert.equal(((await noAuth.json()) as { code: number }).code, 20003);
    const wrong = `Basic ${Buffer.from(`${DEV_TWILIO_ACCOUNT_SID}:nope`).toString('base64')}`;
    assert.equal((await send(server.url, { To: '+250788000160', From: '+15005550006', Body: 'x' }, {}, wrong)).status, 401);
    const cases: [Record<string, string>, number][] = [
      [{ To: '0788000160', From: '+15005550006', Body: 'x' }, 21211],
      [{ To: '+250788000160', Body: 'x' }, 21603],
      [{ To: '+250788000160', From: '+15005550006', Body: ' ' }, 21602],
      [{ To: MAGIC_OPTED_OUT, From: '+15005550006', Body: 'x' }, 21610],
    ];
    for (const [form, code] of cases) {
      const r = await send(server.url, form);
      assert.equal(r.status, 400);
      assert.equal(((await r.json()) as { code: number }).code, code);
    }
  } finally { await server.stop(); }
});

test('an idempotency token returns the same message once', async () => {
  const { server, module } = await start();
  try {
    const form = { To: '+250788000162', From: '+15005550006', Body: 'once' };
    const a = (await (await send(server.url, form, { 'I-Twilio-Idempotency-Token': 'k1' })).json()) as { sid: string };
    const b = (await (await send(server.url, form, { 'I-Twilio-Idempotency-Token': 'k1' })).json()) as { sid: string };
    const c = (await (await send(server.url, form, { 'I-Twilio-Idempotency-Token': 'k2' })).json()) as { sid: string };
    assert.equal(a.sid, b.sid);
    assert.notEqual(a.sid, c.sid);
    assert.equal(module.messages.length, 2);
    assert.equal(module.duplicatesSuppressed(), 1);
  } finally { await server.stop(); }
});

test('the inbox file holds masked destinations and the body, mode 0600, in the dev-inbox shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usrp-sms-inbox-'));
  const inboxFile = join(dir, 'sms', 'inbox.jsonl');
  const { server } = await start({ inboxFile });
  try {
    await send(server.url, { To: '+250788000163', From: '+15005550006', Body: 'Your code is 654321' });
    const line = JSON.parse(readFileSync(inboxFile, 'utf8').trim()) as Record<string, string>;
    assert.equal(line['destinationMasked'], '***63');
    assert.match(line['body'] ?? '', /654321/);
    assert.equal(JSON.stringify(line).includes('250788000163'), false);
    assert.equal(statSync(inboxFile).mode & 0o777, 0o600);
  } finally { await server.stop(); }
});

test('status callbacks are signed (X-Twilio-Signature) and go to loopback only', async () => {
  const received: { signature: string | undefined; params: Record<string, string>; url: string }[] = [];
  const hook = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ signature: req.headers['x-twilio-signature'] as string | undefined, params: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))), url: `http://127.0.0.1:${String((hook.address() as { port: number }).port)}${req.url ?? ''}` });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  const { server } = await start({ queuedMs: 20, sentMs: 40 });
  try {
    const url = `http://127.0.0.1:${String((hook.address() as { port: number }).port)}/status`;
    await send(server.url, { To: '+250788000164', From: '+15005550006', Body: 'x', StatusCallback: url });
    // A non-loopback callback is ignored (no SSRF).
    await send(server.url, { To: '+250788000165', From: '+15005550006', Body: 'x', StatusCallback: 'http://example.com/hook' });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(received.map((r) => r.params['MessageStatus']), ['sent', 'delivered']);
    for (const r of received) assert.equal(r.signature, twilioSignature(DEV_TWILIO_AUTH_TOKEN, url, r.params));
    assert.notEqual(twilioSignature('another-token', url, received[0]?.params ?? {}), received[0]?.signature);
  } finally { await server.stop(); hook.close(); }
});
