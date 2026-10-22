import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePhysicalInput } from '../src/physical.js';

test('malformed ids and codes are refused before any call', () => {
  assert.equal(validatePhysicalInput('00000000-0000-4000-8000-000000000001', 'USRP-QR-ABCDEFGH'), null);
  assert.ok(validatePhysicalInput('not-a-uuid', 'USRP-QR-ABCDEFGH') !== null);
  assert.ok(validatePhysicalInput('00000000-0000-4000-8000-000000000001', 'x') !== null);
  assert.ok(validatePhysicalInput('00000000-0000-4000-8000-000000000001', 'x'.repeat(600)) !== null);
});
