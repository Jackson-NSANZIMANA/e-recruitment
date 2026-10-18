import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNOWN_ROLES } from '@usrp/shared-auth';
import {
  ASSIGNABLE_POSTS,
  DISABLE_REASONS,
  ENABLE_REASONS,
  isAcceptablePassword,
  isReason,
  isSelfModification,
  isUuid,
  normaliseActivationCode,
  normaliseHandle,
  safeCorrelationId,
  validatePosts,
  wouldRemoveLastActiveAdmin,
} from '../src/domain/officer-admin.js';

test('assignable posts are exactly the known roles minus agency_admin', () => {
  assert.deepEqual([...ASSIGNABLE_POSTS].sort(), KNOWN_ROLES.filter((r) => r !== 'agency_admin').sort());
});

test('posts: valid sets are sorted; every refusal is the documented one', () => {
  assert.deepEqual(validatePosts(['screening_officer', 'reviewer']), { ok: true, posts: ['reviewer', 'screening_officer'] });
  assert.deepEqual(validatePosts(['decision_authority']), { ok: true, posts: ['decision_authority'] });
  assert.deepEqual(validatePosts([]), { ok: false, refusal: 'INVALID_POSTS' });
  assert.deepEqual(validatePosts('reviewer'), { ok: false, refusal: 'INVALID_POSTS' });
  assert.deepEqual(validatePosts(null), { ok: false, refusal: 'INVALID_POSTS' });
  assert.deepEqual(validatePosts(['reviewer', 7]), { ok: false, refusal: 'INVALID_POSTS' });
  assert.deepEqual(validatePosts(['reviewer', 'reviewer']), { ok: false, refusal: 'INVALID_POSTS' });
  assert.deepEqual(validatePosts([...ASSIGNABLE_POSTS, 'reviewer']), { ok: false, refusal: 'INVALID_POSTS' });
  assert.deepEqual(validatePosts(['agency_admin']), { ok: false, refusal: 'AGENCY_ADMIN_NOT_ASSIGNABLE' });
  assert.deepEqual(validatePosts(['reviewer', 'agency_admin']), { ok: false, refusal: 'AGENCY_ADMIN_NOT_ASSIGNABLE' });
  assert.deepEqual(validatePosts(['superadmin']), { ok: false, refusal: 'UNKNOWN_POST' });
  assert.deepEqual(validatePosts(['constructor']), { ok: false, refusal: 'UNKNOWN_POST' });
});

test('handles are normalised and bounded', () => {
  assert.equal(normaliseHandle('  RDF.Gate.Gasabo '), 'rdf.gate.gasabo');
  assert.equal(normaliseHandle('ab'), null);
  assert.equal(normaliseHandle('.leading'), null);
  assert.equal(normaliseHandle('has space'), null);
  assert.equal(normaliseHandle('x'.repeat(65)), null);
  assert.equal(normaliseHandle(42), null);
});

test('reason codes are closed per command', () => {
  assert.ok(isReason(DISABLE_REASONS, 'LEFT_SERVICE'));
  assert.ok(!isReason(DISABLE_REASONS, 'RETURNED_TO_DUTY'));
  assert.ok(isReason(ENABLE_REASONS, 'RETURNED_TO_DUTY'));
  assert.ok(!isReason(ENABLE_REASONS, 'free text with a name in it'));
  assert.ok(!isReason(DISABLE_REASONS, undefined));
});

test('self-modification and the last-admin rule', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.ok(isSelfModification(id, id.toUpperCase()));
  assert.ok(!isSelfModification(id, '22222222-2222-4222-8222-222222222222'));
  assert.ok(wouldRemoveLastActiveAdmin({ status: 'active', posts: ['agency_admin'] }, 0));
  assert.ok(!wouldRemoveLastActiveAdmin({ status: 'active', posts: ['agency_admin'] }, 1));
  assert.ok(!wouldRemoveLastActiveAdmin({ status: 'disabled', posts: ['agency_admin'] }, 0));
  assert.ok(!wouldRemoveLastActiveAdmin({ status: 'active', posts: ['reviewer'] }, 0));
});

test('activation code: any case, dashes optional, alphabet enforced', () => {
  assert.equal(normaliseActivationCode('bqmx3-bprpq-thzgx-a2r59'), 'BQMX3BPRPQTHZGXA2R59');
  assert.equal(normaliseActivationCode('BQMX3BPRPQTHZGXA2R59'), 'BQMX3BPRPQTHZGXA2R59');
  assert.equal(normaliseActivationCode('BQMX3-BPRPQ-THZGX-A2R5'), null, 'too short');
  assert.equal(normaliseActivationCode('BQMX3-BPRPQ-THZGX-A2R5O'), null, 'O is not in the alphabet');
  assert.equal(normaliseActivationCode('BQMX3-BPRPQ-THZGX-A2R51'), null, '1 is not in the alphabet');
  assert.equal(normaliseActivationCode(undefined), null);
});

test('password policy, ids and correlation ids', () => {
  assert.ok(isAcceptablePassword('a'.repeat(12)));
  assert.ok(!isAcceptablePassword('a'.repeat(11)));
  assert.ok(!isAcceptablePassword('a'.repeat(257)));
  assert.ok(isUuid('11111111-1111-4111-8111-111111111111'));
  assert.ok(!isUuid('11111111'));
  assert.equal(safeCorrelationId('corr-123', 'fallback'), 'corr-123');
  assert.equal(safeCorrelationId("'; drop", 'fallback'), 'fallback');
});
