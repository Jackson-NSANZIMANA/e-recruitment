// ADR-038: the /version fingerprints are deterministic, sensitive to the
// tables they summarise, and agree with the evidence bundle's projection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { EDGE_OPERATIONS } from '../src/domain/edge-operations.js';
import {
  contractFingerprint,
  operationInventory,
  policyFingerprint,
} from '../src/domain/version-fingerprints.js';

test('contract fingerprint counts every operation and hashes the inventory', () => {
  const fp = contractFingerprint();
  assert.equal(fp.operations, Object.keys(EDGE_OPERATIONS).length);
  const expected = createHash('sha256').update(JSON.stringify(operationInventory())).digest('hex');
  assert.equal(fp.sha256, expected);
  assert.match(fp.sha256, /^[0-9a-f]{64}$/);
});

test('contract fingerprint is order-independent and changes with any operation field', () => {
  const entries = Object.entries(EDGE_OPERATIONS);
  const reversed = Object.fromEntries([...entries].reverse());
  assert.equal(contractFingerprint(reversed).sha256, contractFingerprint().sha256);

  const [firstKey, firstOp] = entries[0]!;
  const mutated = { ...EDGE_OPERATIONS, [firstKey]: { ...firstOp, csrf: !firstOp.csrf } };
  assert.notEqual(contractFingerprint(mutated).sha256, contractFingerprint().sha256);
});

test('inventory carries no free text (composition reasons stay out of the hash)', () => {
  for (const item of operationInventory()) {
    assert.deepEqual(Object.keys(item).sort(), [
      'composition', 'csrf', 'id', 'idempotentWithoutSession', 'maxBodyBytes', 'method',
      'path', 'permission', 'publicAllowlist', 'retryOnG2G', 'session', 'upstream',
    ]);
  }
});

test('policy fingerprint is stable across calls and well-formed', () => {
  const a = policyFingerprint();
  const b = policyFingerprint();
  assert.deepEqual(a, b);
  assert.ok(a.roles > 0);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
});
