// Unit + property tests for the binding rule (ADR-048 §2.1). The property
// tests use a seeded PRNG (no dependency), so a failure is reproducible from
// the printed seed. Every name here is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindCredential,
  compareNames,
  editDistanceAtMostOne,
  nameTokens,
  nationalIdHintOf,
  parseDateOfBirth,
  parseNationalIdHint,
} from '../src/index.js';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['MU', 'KA', 'NI', 'RE', 'BA', 'GI', 'TU', 'HA', 'BI', 'MA', 'NA', 'YE', 'ZA', 'WI', 'RU', 'GE'];
const ACCENTED: Readonly<Record<string, string>> = { A: 'Á', E: 'É', I: 'Í', U: 'Ü' };

function word(rand: () => number): string {
  const n = 2 + Math.floor(rand() * 3);
  let w = '';
  for (let i = 0; i < n; i += 1) w += SYLLABLES[Math.floor(rand() * SYLLABLES.length)] ?? 'MA';
  return w;
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function disguise(token: string, rand: () => number): string {
  let out = '';
  for (const ch of token) {
    const accent = ACCENTED[ch];
    const c = accent !== undefined && rand() < 0.3 ? accent : ch;
    out += rand() < 0.5 ? c.toLowerCase() : c;
  }
  return out;
}

const CASES = 400;

test('property: order, case and diacritics never change an EXACT match', () => {
  for (let seed = 1; seed <= CASES; seed += 1) {
    const rand = prng(seed);
    const tokens = Array.from({ length: 2 + Math.floor(rand() * 2) }, () => word(rand));
    const original = tokens.join(' ');
    const variant = shuffle(tokens, rand).map((t) => disguise(t, rand)).join(rand() < 0.5 ? ' ' : '  ');
    assert.equal(compareNames(original, variant), 'EXACT', `seed ${String(seed)}`);
    const bound = bindCredential({ fullName: original, dateOfBirth: '2003-03-15' }, { holderName: variant, dateOfBirth: '15/03/2003' });
    assert.equal(bound.outcome, 'BOUND', `seed ${String(seed)}`);
  }
});

test('property: one edit on one token is PARTIAL (REVIEW), never BOUND', () => {
  for (let seed = 1; seed <= CASES; seed += 1) {
    const rand = prng(seed * 7);
    const tokens = Array.from({ length: 2 + Math.floor(rand() * 2) }, () => word(rand));
    const k = Math.floor(rand() * tokens.length);
    const target = tokens[k] ?? '';
    const pos = Math.floor(rand() * target.length);
    const edited = rand() < 0.5
      ? target.slice(0, pos) + target.slice(pos + 1) // deletion
      : target.slice(0, pos) + 'Q' + target.slice(pos + 1); // substitution (Q never occurs in SYLLABLES)
    const mutated = tokens.map((t, i) => (i === k ? edited : t));
    // A deletion can coincide with another token; skip that rare degenerate case.
    if (mutated.includes(target) && mutated.filter((t) => t === target).length >= tokens.filter((t) => t === target).length) continue;
    const verdict = compareNames(tokens.join(' '), shuffle(mutated, rand).join(' '));
    if (edited.length < 3) {
      assert.notEqual(verdict, 'EXACT');
      continue;
    }
    assert.equal(verdict, 'PARTIAL', `seed ${String(seed)}: ${tokens.join(' ')} vs ${mutated.join(' ')}`);
    assert.equal(bindCredential({ fullName: tokens.join(' '), dateOfBirth: '2003-03-15' }, { holderName: mutated.join(' ') }).outcome, 'REVIEW');
  }
});

test('property: every DOB spelling of the same day matches; any other day contradicts', () => {
  for (let seed = 1; seed <= CASES; seed += 1) {
    const rand = prng(seed * 13);
    const year = 1980 + Math.floor(rand() * 30);
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);
    const iso = `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dmy = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${String(year)}`;
    const short = `${String(day)}/${String(month)}/${String(year)}`;
    assert.equal(parseDateOfBirth(dmy), iso);
    assert.equal(parseDateOfBirth(short), iso);
    const other = `${String(day === 28 ? 1 : day + 1).padStart(2, '0')}/${String(month).padStart(2, '0')}/${String(year)}`;
    const name = `${word(rand)} ${word(rand)}`;
    assert.equal(bindCredential({ fullName: name, dateOfBirth: iso }, { holderName: name, dateOfBirth: dmy }).outcome, 'BOUND');
    assert.equal(bindCredential({ fullName: name, dateOfBirth: iso }, { holderName: name, dateOfBirth: other }).outcome, 'NOT_BOUND');
  }
});

test('names: tokens, separators, apostrophes', () => {
  assert.deepEqual(nameTokens("  N'dayishimiye  Jean-Pierre "), ['NDAYISHIMIYE', 'JEAN', 'PIERRE']);
  assert.deepEqual(nameTokens('Béata MUKAMANA'), ['BEATA', 'MUKAMANA']);
  assert.equal(compareNames('Beata MUKAMANA', 'MUKAMANA Béata'), 'EXACT');
  assert.equal(compareNames('UWASE Aline Grace', 'UWASE Aline'), 'PARTIAL');
  assert.equal(compareNames('UWASE Aline', 'KAMANZI Eric'), 'MISMATCH');
  assert.equal(compareNames('', 'KAMANZI Eric'), 'MISMATCH');
  assert.equal(compareNames('KAMANZI Eric', 'KAMANZI Erik'), 'PARTIAL');
  assert.equal(compareNames('KAMANZI Eric', 'KAMANZY Erik'), 'MISMATCH'); // two tokens differ
  assert.equal(compareNames('JO KAMANZI', 'JA KAMANZI'), 'MISMATCH'); // too short for the one-edit allowance
});

test('edit distance at most one: insert, delete, substitute, transpose', () => {
  assert.equal(editDistanceAtMostOne('ERIC', 'ERIC'), true);
  assert.equal(editDistanceAtMostOne('ERIC', 'ERIK'), true);
  assert.equal(editDistanceAtMostOne('ERIC', 'ERRIC'), true);
  assert.equal(editDistanceAtMostOne('ERIC', 'EIRC'), true);
  assert.equal(editDistanceAtMostOne('ERIC', 'IERC'), false);
  assert.equal(editDistanceAtMostOne('ERIC', 'ER'), false);
});

test('dates: invalid calendar dates are unreadable', () => {
  assert.equal(parseDateOfBirth('31/02/2003'), null);
  assert.equal(parseDateOfBirth('2003-13-01'), null);
  assert.equal(parseDateOfBirth('yesterday'), null);
  assert.equal(parseDateOfBirth('2003-03-15T00:00:00Z'), '2003-03-15');
});

test('NID hint: masked and plain forms; a contradiction is NOT_BOUND', () => {
  assert.equal(parseNationalIdHint('1200********9999'), '12009999');
  assert.equal(parseNationalIdHint('12009999'), '12009999');
  assert.equal(parseNationalIdHint('1200****9999'), null);
  assert.equal(nationalIdHintOf('1200379990001000'), '12001000');
  assert.equal(nationalIdHintOf('123'), null);
  const identity = { fullName: 'KAMANZI Eric', dateOfBirth: '2003-03-15', sex: 'MALE', nationalIdHint: '12000100' };
  assert.equal(bindCredential(identity, { holderName: 'Eric KAMANZI', sex: 'MALE', nationalIdHint: '1200********0100' }).outcome, 'BOUND');
  const wrongHint = bindCredential(identity, { holderName: 'Eric KAMANZI', nationalIdHint: '1200********0101' });
  assert.equal(wrongHint.outcome, 'NOT_BOUND');
  assert.equal(wrongHint.fields.nationalIdHint, 'MISMATCH');
  assert.equal(bindCredential(identity, { holderName: 'Eric KAMANZI', sex: 'F' }).outcome, 'NOT_BOUND');
  assert.equal(bindCredential(identity, { holderName: 'Eric KAMANZI', sex: 'UNKNOWN' }).outcome, 'REVIEW');
  assert.equal(bindCredential(identity, { holderName: 'Eric KAMANZI', nationalIdHint: 'garbled' }).outcome, 'REVIEW');
});

test('a missing identity-side hint is NOT_COMPARED and does not block BOUND', () => {
  const result = bindCredential({ fullName: 'KAMANZI Eric', dateOfBirth: '2003-03-15', nationalIdHint: null }, { holderName: 'KAMANZI Eric', nationalIdHint: '1200********0100' });
  assert.equal(result.outcome, 'BOUND');
  assert.equal(result.fields.nationalIdHint, 'NOT_COMPARED');
});

test('required identity evidence missing on the applicant yields REVIEW', () => {
  const result = bindCredential(
    { fullName: 'KAMANZI Eric', dateOfBirth: '2003-03-15', sex: 'MALE', nationalIdHint: null },
    { holderName: 'Eric KAMANZI', sex: 'MALE', nationalIdHint: '1200********0100' },
    { requiredFields: ['sex', 'nationalIdHint'] },
  );
  assert.equal(result.fields.nationalIdHint, 'NOT_COMPARED');
  assert.equal(result.outcome, 'REVIEW');
});

test('a name mismatch is NOT_BOUND even when everything else matches; the result carries no values', () => {
  const result = bindCredential({ fullName: 'KAMANZI Eric', dateOfBirth: '2003-03-15', sex: 'MALE' }, { holderName: 'UWASE Aline', dateOfBirth: '15/03/2003', sex: 'MALE' });
  assert.equal(result.outcome, 'NOT_BOUND');
  assert.equal(JSON.stringify(result).includes('KAMANZI'), false);
  assert.equal(JSON.stringify(result).includes('2003'), false);
});
