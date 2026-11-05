import test from 'node:test';
import assert from 'node:assert/strict';
import { isContentReviewOnly } from '../src/adapters/clearance-content-review.pg.js';
import { loadClearanceContentReviewAdmitsToExam } from '../src/config.js';

test('content-only means REVIEW with exactly CLEARANCE_CONTENT_REVIEW', () => {
  assert.equal(isContentReviewOnly('REVIEW', ['CLEARANCE_CONTENT_REVIEW']), true);
  assert.equal(isContentReviewOnly('REVIEW', ['CLEARANCE_CONTENT_REVIEW', 'IDENTITY_NAME_PARTIAL']), false);
  assert.equal(isContentReviewOnly('REVIEW', ['IDENTITY_NAME_PARTIAL']), false);
  assert.equal(isContentReviewOnly('REVIEW', []), false);
  assert.equal(isContentReviewOnly('REVIEW', null), false);
  assert.equal(isContentReviewOnly('CLEARED', ['CLEARANCE_CONTENT_REVIEW']), false);
  assert.equal(isContentReviewOnly(null, null), false);
});

test('the switch: off by default, on only in sandbox/development, refused in production', () => {
  assert.equal(loadClearanceContentReviewAdmitsToExam({}), false);
  assert.equal(loadClearanceContentReviewAdmitsToExam({ CLEARANCE_CONTENT_REVIEW_ADMITS_TO_EXAM: 'false' }), false);
  assert.equal(loadClearanceContentReviewAdmitsToExam({ CLEARANCE_CONTENT_REVIEW_ADMITS_TO_EXAM: 'true' }), true);
  assert.equal(loadClearanceContentReviewAdmitsToExam({ CLEARANCE_CONTENT_REVIEW_ADMITS_TO_EXAM: 'true', NODE_ENV: 'production', USRP_ENVIRONMENT: 'sandbox' }), true);
  assert.throws(() => loadClearanceContentReviewAdmitsToExam({ CLEARANCE_CONTENT_REVIEW_ADMITS_TO_EXAM: 'true', NODE_ENV: 'production' }), /sandbox decision/);
  assert.throws(() => loadClearanceContentReviewAdmitsToExam({ CLEARANCE_CONTENT_REVIEW_ADMITS_TO_EXAM: 'yes' }), /true or false/);
});
