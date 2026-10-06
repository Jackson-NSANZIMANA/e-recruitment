import test from 'node:test';
import assert from 'node:assert/strict';
import { compareClocks, mergeVectorClock } from '../src/domain/vector-clock.js';
import { decideMerge } from '../src/domain/merge.js';

test('compareClocks: detects DOMINATES, DOMINATED, EQUAL, and CONCURRENT', () => {
  const clockA = { dev1: 2, dev2: 1 };
  const clockB = { dev1: 1, dev2: 1 };
  const clockC = { dev1: 1, dev2: 2 };
  const clockD = { dev1: 2, dev2: 1 };

  assert.equal(compareClocks(clockA, clockB), 'DOMINATES');
  assert.equal(compareClocks(clockB, clockA), 'DOMINATED');
  assert.equal(compareClocks(clockA, clockD), 'EQUAL');
  assert.equal(compareClocks(clockA, clockC), 'CONCURRENT');
});

test('mergeVectorClock: calculates pointwise maximum', () => {
  const a = { dev1: 3, dev2: 1 };
  const b = { dev1: 2, dev2: 4, dev3: 1 };
  const merged = mergeVectorClock(a, b);
  assert.deepEqual(merged, { dev1: 3, dev2: 4, dev3: 1 });
});

test('decideMerge: handles new head, duplicates, stale records and conflicts', () => {
  // First record when empty
  const d1 = decideMerge(
    { vectorClock: { dev1: 1 }, signedPayloadHash: 'hash1' },
    [],
  );
  assert.equal(d1.kind, 'ACCEPT');

  // Exact duplicate
  const d2 = decideMerge(
    { vectorClock: { dev1: 1 }, signedPayloadHash: 'hash1' },
    [{ vectorClock: { dev1: 1 }, signedPayloadHash: 'hash1' }],
  );
  assert.equal(d2.kind, 'DUPLICATE');

  // Dominating new head
  const d3 = decideMerge(
    { vectorClock: { dev1: 2 }, signedPayloadHash: 'hash2' },
    [{ vectorClock: { dev1: 1 }, signedPayloadHash: 'hash1' }],
  );
  assert.equal(d3.kind, 'SUPERSEDE');

  // Stale incoming record
  const d4 = decideMerge(
    { vectorClock: { dev1: 1 }, signedPayloadHash: 'hashOld' },
    [{ vectorClock: { dev1: 2 }, signedPayloadHash: 'hash2' }],
  );
  assert.equal(d4.kind, 'STALE');

  // Concurrent offline entries -> CONFLICT
  const d5 = decideMerge(
    { vectorClock: { dev1: 2, dev2: 0 }, signedPayloadHash: 'hashDev1' },
    [{ vectorClock: { dev1: 0, dev2: 2 }, signedPayloadHash: 'hashDev2' }],
  );
  assert.equal(d5.kind, 'CONFLICT');
});
