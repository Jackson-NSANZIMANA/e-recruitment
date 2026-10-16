// LogSmsChannel's dev inbox: off by default, and when on it writes the body
// (the OTP a developer needs) to an owner-only file while the log line stays
// masked. Runs against the built dist (the `test` script compiles first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogSmsChannel } from '../dist/index.js';

const MESSAGE = { destination: '0788123456', body: 'USRP code: 482913. Valid 5 minutes.' };

test('no inbox unless asked for, including an empty path', async () => {
  for (const options of [undefined, {}, { inboxFile: '' }, { inboxFile: '   ' }]) {
    const channel = new LogSmsChannel(options);
    assert.equal(channel.inboxFile, null);
    assert.equal(await channel.send(MESSAGE), 'ACCEPTED');
    assert.equal(channel.sent.length, 1);
  }
});

test('the inbox records the body with a masked destination, owner-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usrp-sms-'));
  const file = join(dir, 'nested', 'inbox.jsonl');
  const channel = new LogSmsChannel({ inboxFile: file });
  assert.equal(channel.inboxFile, file);

  await channel.send(MESSAGE);
  await channel.send({ destination: '0722000011', body: 'second' });

  assert.ok(existsSync(file));
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].body, MESSAGE.body);
  assert.equal(lines[0].destinationMasked, '***56');
  assert.ok(!readFileSync(file, 'utf8').includes(MESSAGE.destination), 'raw phone number must not be written');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
