import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveApplicationStatus, type VettingEvidence } from '../src/domain/lifecycle.js';

test('deriveApplicationStatus: when all three gates pass, advances to DOCUMENT_REVIEW_GREEN', () => {
  const evidence: VettingEvidence = {
    ageStatus: 'ELIGIBLE',
    academicStatus: 'ELIGIBLE',
    criminalStatus: 'CLEARED',
  };
  const next = deriveApplicationStatus('SUBMITTED', evidence);
  assert.equal(next, 'DOCUMENT_REVIEW_GREEN');
});

test('deriveApplicationStatus: hard fail in early vetting leads to REJECTED', () => {
  // Age ineligible
  const badAge: VettingEvidence = {
    ageStatus: 'INELIGIBLE',
    academicStatus: 'PENDING',
    criminalStatus: 'PENDING',
  };
  assert.equal(deriveApplicationStatus('SUBMITTED', badAge), 'REJECTED');

  // Academic ineligible
  const badAcad: VettingEvidence = {
    ageStatus: 'ELIGIBLE',
    academicStatus: 'INELIGIBLE',
    criminalStatus: 'PENDING',
  };
  assert.equal(deriveApplicationStatus('SUBMITTED', badAcad), 'REJECTED');

  // Criminal conviction
  const badCrim: VettingEvidence = {
    ageStatus: 'ELIGIBLE',
    academicStatus: 'ELIGIBLE',
    criminalStatus: 'FLAGGED_CONVICTION',
  };
  assert.equal(deriveApplicationStatus('SUBMITTED', badCrim), 'REJECTED');
});

test('deriveApplicationStatus: late hard fail past SLOT_ASSIGNED holds at ADJUDICATION_REVIEW', () => {
  const lateFlag: VettingEvidence = {
    ageStatus: 'ELIGIBLE',
    academicStatus: 'ELIGIBLE',
    criminalStatus: 'FLAGGED_CONVICTION',
  };
  assert.equal(deriveApplicationStatus('SLOT_ASSIGNED', lateFlag), 'ADJUDICATION_REVIEW');
  assert.equal(deriveApplicationStatus('PHYSICAL_TEST_SCHEDULED', lateFlag), 'ADJUDICATION_REVIEW');
});

test('deriveApplicationStatus: terminal states are never mutated', () => {
  const evidence: VettingEvidence = {
    ageStatus: 'ELIGIBLE',
    academicStatus: 'ELIGIBLE',
    criminalStatus: 'CLEARED',
  };
  assert.equal(deriveApplicationStatus('REJECTED', evidence), 'REJECTED');
  assert.equal(deriveApplicationStatus('WITHDRAWN', evidence), 'WITHDRAWN');
  assert.equal(deriveApplicationStatus('ACCEPTED', evidence), 'ACCEPTED');
  assert.equal(deriveApplicationStatus('WALK_IN_REJECTED', evidence), 'WALK_IN_REJECTED');
});

// ── Owner decision 2026-11-05 (ADR-048 §4): a content-only certificate review lets the exam go ahead ──

const READING: VettingEvidence = {
  ageStatus: 'ELIGIBLE',
  academicStatus: 'ELIGIBLE',
  criminalStatus: 'UNDER_REVIEW',
  criminalContentReviewOnly: true,
};
const ADMITS = { clearanceContentReviewAdmitsToExam: true } as const;

test('content-only review: with the policy on, the applicant reaches GREEN (slot, invitation, QR)', () => {
  assert.equal(deriveApplicationStatus('SUBMITTED', READING, ADMITS), 'DOCUMENT_REVIEW_GREEN');
  assert.equal(deriveApplicationStatus('CRIMINAL_CLEARANCE', READING, ADMITS), 'DOCUMENT_REVIEW_GREEN');
});

test('content-only review: with the policy off (production default), ADR-033 holds the QR', () => {
  assert.equal(deriveApplicationStatus('SUBMITTED', READING), 'CRIMINAL_CLEARANCE');
  assert.equal(deriveApplicationStatus('SUBMITTED', READING, { clearanceContentReviewAdmitsToExam: false }), 'CRIMINAL_CLEARANCE');
});

test('an identity doubt is never content-only: a partial name still waits for the officer before any QR', () => {
  const doubt: VettingEvidence = { ...READING, criminalContentReviewOnly: false };
  assert.equal(deriveApplicationStatus('SUBMITTED', doubt, ADMITS), 'CRIMINAL_CLEARANCE');
  const unknown: VettingEvidence = { ageStatus: 'ELIGIBLE', academicStatus: 'ELIGIBLE', criminalStatus: 'UNDER_REVIEW' };
  assert.equal(deriveApplicationStatus('SUBMITTED', unknown, ADMITS), 'CRIMINAL_CLEARANCE');
});

test('content-only review never overrides another gate, and never revives a hard fail', () => {
  assert.equal(deriveApplicationStatus('SUBMITTED', { ...READING, academicStatus: 'PENDING' }, ADMITS), 'CRIMINAL_CLEARANCE');
  assert.equal(deriveApplicationStatus('SUBMITTED', { ...READING, ageStatus: 'INELIGIBLE' }, ADMITS), 'REJECTED');
  // A conviction found later, on a scheduled applicant, is the existing late-flag hold.
  assert.equal(deriveApplicationStatus('SLOT_ASSIGNED', { ...READING, criminalStatus: 'FLAGGED_CONVICTION' }, ADMITS), 'ADJUDICATION_REVIEW');
  // A stale content-only fact never stands in for a criminal verdict that is not UNDER_REVIEW.
  assert.equal(deriveApplicationStatus('SUBMITTED', { ...READING, criminalStatus: 'PENDING' }, ADMITS), 'ACADEMIC_VETTING');
});
