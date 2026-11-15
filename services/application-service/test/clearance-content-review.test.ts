import test from 'node:test';
import assert from 'node:assert/strict';
import { certificateRequired, isContentReviewOnly } from '../src/adapters/clearance-content-review.pg.js';
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

test('agency record check: a category asks for the certificate exactly as the checklist resolves it', () => {
  // As printed: RNP asks for no criminal-record certificate; RDF and RCS do.
  assert.equal(certificateRequired('BASIC_POLICE_COURSE', undefined), false);
  assert.equal(certificateRequired('CADET_OFFICER', undefined), false);
  assert.equal(certificateRequired('GENERAL_ENLISTMENT', undefined), true);
  assert.equal(certificateRequired('GENERAL_ENLISTEE', undefined), true);
  // The bound policy's list wins over the table, both ways.
  assert.equal(certificateRequired('BASIC_POLICE_COURSE', ['NATIONAL_ID', 'NON_CONVICTION_CERTIFICATE']), true);
  assert.equal(certificateRequired('GENERAL_ENLISTMENT', ['NATIONAL_ID']), false);
  // An explicitly empty policy list is respected (ADR-032): nothing is asked.
  assert.equal(certificateRequired('GENERAL_ENLISTMENT', []), false);
  // A damaged list is not a policy: the table decides.
  assert.equal(certificateRequired('GENERAL_ENLISTMENT', 'oops'), true);
});
