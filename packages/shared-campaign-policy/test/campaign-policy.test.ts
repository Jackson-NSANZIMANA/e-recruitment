// Tests for campaign policy v2 (ADR-049). Every value restates
// docs/product/recruitment-announcements-2025-2026.md; nothing here is personal data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PolicyV2Error, ageBandFor, checkEnvelope, convictionVerdict, documentPlan, educationSatisfied,
  evaluateAgeForQualification, normalizePolicyV2, readPolicyV2, scienceSatisfied, v1CriminalThreshold,
} from '../src/index.js';

const reserve = {
  schemaVersion: 2,
  ageBands: [
    { qualifications: ['A_LEVEL_A2'], minimumAge: 18, maximumAge: 25 },
    { qualifications: ['BACHELOR_A0', 'A1_IPRC'], minimumAge: 18, maximumAge: 26 },
    { qualifications: ['FIELD:MEDICINE', 'FIELD:ENGINEERING', 'FIELD:LAW'], minimumAge: 18, maximumAge: 27 },
  ],
  educationAlternatives: [{ level: 'A_LEVEL_A2' }, { level: 'A1_IPRC' }, { level: 'BACHELOR_A0' }],
  minimumSciencePercent: null,
  conviction: { rule: 'NEVER_CONVICTED', notUnderProsecution: false },
  documents: [
    { type: 'NATIONAL_ID', satisfaction: 'REGISTRY_VERIFIED', notarised: false },
    { type: 'GOOD_CONDUCT_CERTIFICATE', satisfaction: 'UPLOAD', notarised: false },
  ],
  clearance: { allowedCertificateCodes: ['CODE_B', 'CODE_A'], noRecordCertificateCodes: ['CODE_A'], validityDays: 90 },
};

test('RDF Reserve: three caps by qualification inside one category', () => {
  const p = normalizePolicyV2(reserve);
  assert.equal(evaluateAgeForQualification(p, { level: 'A_LEVEL_A2', field: null }, 25).eligible, true);
  const a26 = evaluateAgeForQualification(p, { level: 'A_LEVEL_A2', field: null }, 26);
  assert.deepEqual([a26.eligible, a26.code, a26.cap], [false, 'ABOVE_CAP', 25]);
  assert.equal(evaluateAgeForQualification(p, { level: 'BACHELOR_A0', field: null }, 26).eligible, true);
  const a27 = evaluateAgeForQualification(p, { level: 'BACHELOR_A0', field: null }, 27);
  assert.deepEqual([a27.eligible, a27.cap], [false, 26]);
  // Medicine graduate aged 27: the most generous matching band wins.
  assert.equal(evaluateAgeForQualification(p, { level: 'BACHELOR_A0', field: 'MEDICINE' }, 27).eligible, true);
  assert.equal(evaluateAgeForQualification(p, { level: 'BACHELOR_A0', field: 'MEDICINE' }, 28).eligible, false);
  assert.equal(evaluateAgeForQualification(p, { level: 'BACHELOR_A0', field: null }, 17).code, 'BELOW_MINIMUM');
  assert.equal(evaluateAgeForQualification(p, { level: 'O_LEVEL_S3', field: null }, 20).code, 'NO_BAND_FOR_QUALIFICATION');
  assert.equal(ageBandFor(p, { level: null, field: null }), null);
});

test('normalisation is canonical: order of the authored input does not change the result', () => {
  const shuffled = { ...reserve, ageBands: [...reserve.ageBands].reverse(), educationAlternatives: [...reserve.educationAlternatives].reverse() };
  assert.deepEqual(normalizePolicyV2(shuffled), normalizePolicyV2(reserve));
  assert.deepEqual(normalizePolicyV2(reserve).clearance?.allowedCertificateCodes, ['CODE_A', 'CODE_B']);
});

test('education alternatives: A0 OR A1 IPRC, and S3 as a minimum below A2', () => {
  const p = normalizePolicyV2({ ...reserve, educationAlternatives: [{ level: 'BACHELOR_A0' }, { level: 'A1_IPRC' }] });
  assert.equal(educationSatisfied(p, 'A1_IPRC'), true);
  assert.equal(educationSatisfied(p, 'BACHELOR_A0'), true);
  assert.equal(educationSatisfied(p, 'A_LEVEL_A2'), false);
  const s3 = normalizePolicyV2({ ...reserve, educationAlternatives: [{ level: 'O_LEVEL_S3' }] });
  assert.equal(educationSatisfied(s3, 'O_LEVEL_S3'), true);
  assert.equal(educationSatisfied(s3, 'A_LEVEL_A2'), true);
});

test('science bar: 70% passes, 69% does not, absent fails closed', () => {
  const p = normalizePolicyV2({ ...reserve, minimumSciencePercent: 70 });
  assert.equal(scienceSatisfied(p, 70), true);
  assert.equal(scienceSatisfied(p, 69), false);
  assert.equal(scienceSatisfied(p, undefined), false);
  assert.equal(scienceSatisfied(normalizePolicyV2(reserve), undefined), true);
});

test('the four conviction rules from the announcements', () => {
  const rule = (r: string, prosecution = false) => normalizePolicyV2({ ...reserve, conviction: { rule: r, notUnderProsecution: prosecution } });
  const clean = { convicted: false, longestSentenceMonths: null, underProsecution: false };
  assert.equal(convictionVerdict(rule('NEVER_CONVICTED'), { ...clean, convicted: true, longestSentenceMonths: 1 }).code, 'CONVICTED');
  assert.equal(convictionVerdict(rule('NO_SENTENCE_6M_OR_MORE'), { ...clean, convicted: true, longestSentenceMonths: 6 }).code, 'SENTENCE_BARS');
  assert.equal(convictionVerdict(rule('NO_SENTENCE_6M_OR_MORE'), { ...clean, convicted: true, longestSentenceMonths: 5 }).eligible, true);
  assert.equal(convictionVerdict(rule('NO_SENTENCE_OVER_6M'), { ...clean, convicted: true, longestSentenceMonths: 6 }).eligible, true);
  assert.equal(convictionVerdict(rule('NO_SENTENCE_OVER_6M'), { ...clean, convicted: true, longestSentenceMonths: 7 }).code, 'SENTENCE_BARS');
  assert.equal(convictionVerdict(rule('NEVER_CONVICTED', true), { ...clean, underProsecution: true }).code, 'UNDER_PROSECUTION');
  assert.equal(convictionVerdict(rule('NEVER_CONVICTED', false), { ...clean, underProsecution: true }).eligible, true);
});

test('malformed authored input is refused with a closed code', () => {
  const bad = (patch: Record<string, unknown>) => assert.throws(() => normalizePolicyV2({ ...reserve, ...patch }), PolicyV2Error);
  bad({ schemaVersion: 1 });
  bad({ ageBands: [] });
  bad({ ageBands: [{ qualifications: ['A_LEVEL_A2'], minimumAge: 30, maximumAge: 20 }] });
  bad({ ageBands: [{ qualifications: ['A_LEVEL_A2'], minimumAge: 18, maximumAge: 25 }, { qualifications: ['A_LEVEL_A2'], minimumAge: 18, maximumAge: 26 }] });
  bad({ ageBands: [{ qualifications: ['FIELD:ASTROLOGY'], minimumAge: 18, maximumAge: 25 }] });
  bad({ conviction: { rule: 'SOMETIMES', notUnderProsecution: false } });
  bad({ educationAlternatives: [{ level: 'A1_IPRC' }, { level: 'A1_IPRC' }] });
  bad({ documents: [{ type: 'NATIONAL_ID', satisfaction: 'TELEPATHY', notarised: false }] });
  bad({ clearance: { allowedCertificateCodes: ['A'], noRecordCertificateCodes: ['B'], validityDays: 90 } });
  bad({ clearance: { allowedCertificateCodes: ['CODE_A'], noRecordCertificateCodes: [], validityDays: 0 } });
  bad({ extra: true });
  assert.equal(readPolicyV2({ nope: 1 }), null);
});

test('the v1 envelope cannot contradict the v2 block', () => {
  const p = normalizePolicyV2(reserve);
  const v1 = { age: { minimumAge: 18, maximumAge: 27 }, criminalThreshold: 'ANY_CONVICTION', requiredDocumentTypes: ['NATIONAL_ID', 'GOOD_CONDUCT_CERTIFICATE'] };
  assert.equal(checkEnvelope(p, v1), null);
  assert.match(checkEnvelope(p, { ...v1, age: { minimumAge: 18, maximumAge: 25 } }) ?? '', /widest/);
  assert.match(checkEnvelope(p, { ...v1, criminalThreshold: 'IMPRISONMENT_GT_6MO' }) ?? '', /conviction/);
  assert.match(checkEnvelope(p, { ...v1, requiredDocumentTypes: ['NATIONAL_ID'] }) ?? '', /documents/);
  assert.equal(v1CriminalThreshold('NO_SENTENCE_6M_OR_MORE'), 'IMPRISONMENT_GTE_6MO');
});

test('document plan splits by satisfaction mode', () => {
  const plan = documentPlan(normalizePolicyV2(reserve));
  assert.deepEqual(plan.registry.map((d) => d.type), ['NATIONAL_ID']);
  assert.deepEqual(plan.upload.map((d) => d.type), ['GOOD_CONDUCT_CERTIFICATE']);
  assert.equal(plan.atVenue.length, 0);
});
