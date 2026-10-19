import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveGateIdentity, requiresManualIdentity, EVIDENCE_OUTCOMES, type VisibleEvidence } from '../src/domain/gate-identity.js';

const GATE = 'gate-officer';
const SUP = 'supervisor';
const ev = (id: string, outcome: VisibleEvidence['outcome'], confirmedBy: string | null = null): VisibleEvidence => ({
  evidenceId: id,
  outcome,
  confirmation: confirmedBy === null ? null : { confirmationId: `c-${id}`, confirmedById: confirmedBy },
});

test('no evidence or only NOT_ATTEMPTED: the card number alone, without prejudice', () => {
  assert.deepEqual(resolveGateIdentity([], GATE), { kind: 'IDENTIFIED', identityMethod: 'NATIONAL_ID_CARD', evidenceIds: [], confirmationIds: [] });
  assert.equal((resolveGateIdentity([ev('a', 'NOT_ATTEMPTED')], GATE) as { identityMethod: string }).identityMethod, 'NATIONAL_ID_CARD');
});

test('a MATCH records the second identity method', () => {
  const d = resolveGateIdentity([ev('a', 'NOT_ATTEMPTED'), ev('b', 'MATCH')], GATE);
  assert.deepEqual(d, { kind: 'IDENTIFIED', identityMethod: 'NATIONAL_ID_CARD+CARD_PORTRAIT', evidenceIds: ['a', 'b'], confirmationIds: [] });
});

test('NO_MATCH / INCONCLUSIVE never refuse: they require supervised manual identity', () => {
  for (const o of ['NO_MATCH', 'INCONCLUSIVE'] as const) {
    assert.deepEqual(resolveGateIdentity([ev('a', o)], GATE), { kind: 'MANUAL_IDENTITY_REQUIRED', evidenceIds: ['a'] });
    const ok = resolveGateIdentity([ev('a', o, SUP)], GATE);
    assert.deepEqual(ok, { kind: 'IDENTIFIED', identityMethod: 'NATIONAL_ID_CARD+SUPERVISOR', evidenceIds: ['a'], confirmationIds: ['c-a'] });
  }
});

test('a later MATCH or NOT_ATTEMPTED does not clear an unconfirmed negative', () => {
  assert.equal(resolveGateIdentity([ev('a', 'NO_MATCH'), ev('b', 'MATCH')], GATE).kind, 'MANUAL_IDENTITY_REQUIRED');
  assert.equal(resolveGateIdentity([ev('a', 'INCONCLUSIVE'), ev('b', 'NOT_ATTEMPTED')], GATE).kind, 'MANUAL_IDENTITY_REQUIRED');
});

test('a confirmation by the admitting officer does not count (two-person rule)', () => {
  assert.deepEqual(resolveGateIdentity([ev('a', 'NO_MATCH', GATE)], GATE), { kind: 'MANUAL_IDENTITY_REQUIRED', evidenceIds: ['a'] });
});

test('every negative must be confirmed', () => {
  assert.deepEqual(resolveGateIdentity([ev('a', 'NO_MATCH', SUP), ev('b', 'INCONCLUSIVE')], GATE), { kind: 'MANUAL_IDENTITY_REQUIRED', evidenceIds: ['b'] });
});

test('requiresManualIdentity is exhaustive over the outcome union', () => {
  assert.deepEqual(EVIDENCE_OUTCOMES.filter(requiresManualIdentity), ['NO_MATCH', 'INCONCLUSIVE']);
});
