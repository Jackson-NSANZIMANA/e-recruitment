import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashNationalId,
  hashPhoneNumber,
  timingSafeEqualHex,
  hashPassword,
  verifyPassword,
  InvalidNationalIdError,
} from '../src/hashing.js';

test('hashNationalId: valid 16-digit Rwandan NID produces 64-char hex', () => {
  const hmacKey = 'dev_national_id_hmac_key_min_32_chars!!';
  const nid = '1199880012345678';
  const hashed = hashNationalId(nid, hmacKey);
  assert.equal(hashed.length, 64);
  assert.match(hashed, /^[0-9a-f]{64}$/);

  // Deterministic with same key
  assert.equal(hashNationalId(nid, hmacKey), hashed);
});

test('hashNationalId: rejects non-16-digit input', () => {
  const hmacKey = 'dev_national_id_hmac_key_min_32_chars!!';
  assert.throws(() => hashNationalId('123', hmacKey), InvalidNationalIdError);
  assert.throws(() => hashNationalId('11998800123456789', hmacKey), InvalidNationalIdError);
  assert.throws(() => hashNationalId('119988001234567a', hmacKey), InvalidNationalIdError);
});

test('timingSafeEqualHex: correctly compares equal and non-equal hex', () => {
  const h1 = 'abcdef1234567890';
  const h2 = 'abcdef1234567890';
  const h3 = 'abcdef1234567891';
  assert.equal(timingSafeEqualHex(h1, h2), true);
  assert.equal(timingSafeEqualHex(h1, h3), false);
  assert.equal(timingSafeEqualHex(h1, 'short'), false);
});

test('hashPassword & verifyPassword: scrypt roundtrip and invalid comparison', () => {
  const pw = 'RwandaSecurePass2026!';
  const encoded = hashPassword(pw);
  assert.match(encoded, /^scrypt\$16384\$8\$1\$/);

  // Correct password verifies
  assert.equal(verifyPassword(pw, encoded), true);

  // Wrong password fails
  assert.equal(verifyPassword('WrongPassword', encoded), false);

  // Malformed encoded hash returns false safely without throwing
  assert.equal(verifyPassword(pw, 'not-a-valid-hash'), false);
});
