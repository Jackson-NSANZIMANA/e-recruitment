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
