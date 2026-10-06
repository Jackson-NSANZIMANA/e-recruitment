import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newCsrfToken,
  csrfTokenHash,
  newSessionHandle,
  sessionHandleHash,
} from '../src/crypto/tokens.js';

test('newCsrfToken: generates 64-char hex string (32 bytes)', () => {
  const t1 = newCsrfToken();
  const t2 = newCsrfToken();
  assert.equal(t1.length, 64);
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.notEqual(t1, t2);
});

test('csrfTokenHash: derives domain-separated HMAC-SHA256 hex', () => {
  const hmacKey = 'dev_edge_session_hmac_key_min_32_chars!!';
  const token = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const hash = csrfTokenHash(hmacKey, token);
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
  // Deterministic for same inputs
  assert.equal(csrfTokenHash(hmacKey, token), hash);
});

test('newSessionHandle & sessionHandleHash: opaque handle and domain-separated hash', () => {
  const hmacKey = 'dev_edge_session_hmac_key_min_32_chars!!';
  const handle = newSessionHandle();
  assert.ok(handle.length >= 40);
  const hash = sessionHandleHash(hmacKey, handle);
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});
