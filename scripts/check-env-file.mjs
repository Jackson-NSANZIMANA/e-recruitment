#!/usr/bin/env node
// Validate the data-only subset of Bash used by our environment files BEFORE
// sourcing it. `bash -n` is insufficient: pasted prose such as "THERE ARE ..."
// is valid shell syntax, and used to become twelve unrelated readiness failures.
// No dependencies, no evaluation, and no secret values in diagnostics.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function valueProblem(value) {
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      // Escapes are literal; a trailing escape would continue onto another line.
      if (i + 1 === value.length) return 'line continuations are not allowed; keep each assignment on one line';
      i += 1;
      continue;
    }
    if (char === '$' || char === '`') {
      return 'shell expansion is not allowed; put literal values containing $ or backticks in single quotes';
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ' ' || char === '\t') {
      const rest = value.slice(i).trimStart();
      if (rest === '' || rest.startsWith('#')) return null;
      return 'unexpected text after the value; quote values containing spaces and start comments with #';
    } else if (/[;&|<>()]/u.test(char)) {
      return 'shell commands and operators are not allowed; quote literal values containing punctuation';
    } else if (char === '~') {
      return 'tilde expansion is not allowed; quote the value or supply a literal path';
    }
  }
  return quote === null ? null : 'unterminated quote; keep each assignment on one line';
}

/** Accept comments, blank lines and single-line literal KEY=value assignments. */
export function findEnvErrors(content) {
  const errors = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // CRLF is accepted; dev.sh normalizes the same trailing CR before sourcing.
    const line = lines[i].replace(/\r$/u, '');
    if (/^[\t ]*(?:#.*)?$/u.test(line)) continue;
    let reason;
    if (/[\0\r]/u.test(line)) {
      reason = 'NUL bytes and embedded carriage returns are not allowed';
    } else {
      const assignment = /^[\t ]*(?:export[\t ]+)?[A-Za-z_][A-Za-z0-9_]*=(.*)$/u.exec(line);
      reason = assignment === null
        ? 'expected a KEY=value assignment or a # comment (not prose or a shell command)'
        : valueProblem(assignment[1]);
    }
    if (reason !== null) errors.push({ line: i + 1, reason });
  }
  return errors;
}

function main(args) {
  if (args.length !== 1) {
    console.error('Usage: node scripts/check-env-file.mjs <env-file>');
    return 2;
  }
  const file = args[0];
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    console.error(`✗ cannot read environment file: ${file}`);
    return 1;
  }
  const errors = findEnvErrors(content);
  if (errors.length > 0) {
    console.error(`✗ invalid environment file: ${file}`);
    for (const { line, reason } of errors.slice(0, 20)) {
      console.error(`  ${file}:${line}: ${reason}`);
    }
    if (errors.length > 20) console.error(`  ... and ${errors.length - 20} more invalid lines`);
    console.error('  Remove pasted text or prefix it with #. Use single quotes for literal secrets.');
    console.error('  No services were started; environment values are intentionally not printed.');
    return 1;
  }
  console.log(`✓ environment file syntax: ${file} (literal assignments and comments only)`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
