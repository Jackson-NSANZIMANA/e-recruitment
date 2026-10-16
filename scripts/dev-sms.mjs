#!/usr/bin/env node
// Prints the latest messages from the dev SMS inbox written by LogSmsChannel
// (see scripts/dev.sh). Dev only: the inbox never exists in production.
//
//   pnpm dev:sms          last 5 messages
//   pnpm dev:sms 20       last 20 messages
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const file = process.env.DEV_SMS_INBOX_FILE || join(root, '.dev-sms', 'inbox.jsonl');
const count = Math.max(1, Number.parseInt(process.argv[2] ?? '5', 10) || 5);

if (!existsSync(file)) {
  console.log(`No dev SMS inbox yet at ${file}.`);
  console.log('Start the stack with `pnpm dev`, then request a code from the applicant portal.');
  process.exit(0);
}

const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
for (const line of lines.slice(-count)) {
  try {
    const { at, destinationMasked, body } = JSON.parse(line);
    console.log(`${at}  to ${destinationMasked}\n  ${String(body).replace(/\n/g, '\n  ')}\n`);
  } catch {
    console.log(`(unreadable line) ${line.slice(0, 80)}`);
  }
}
