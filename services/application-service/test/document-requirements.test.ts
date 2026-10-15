import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENCY_DOCUMENT_TYPES, REQUIRED_DOCUMENTS, agencyForCategory, type ApplicationCategory, type DocumentType } from '@usrp/shared-types';
import {
  REGISTRY_FOR_DOCUMENT,
  evaluateDocumentChecklist,
  resolveRequiredDocuments,
  type GateVerdicts,
  type StoredDocument,
} from '../src/domain/document-requirements.js';

const pending: GateVerdicts = { identityVerified: true, academicStatus: 'PENDING', criminalStatus: 'PENDING' };
const allPassed: GateVerdicts = { identityVerified: true, academicStatus: 'ELIGIBLE', criminalStatus: 'CLEARED' };
const doc = (documentType: DocumentType, over: Partial<StoredDocument> = {}): StoredDocument => ({
  documentType,
  forensicsLane: null,
  verifiedViaApi: false,
  humanReviewDecision: null,
  virusScanPassed: true,
  venueVerified: false,
  ...over,
});

test('ground truth: every category in the announcements has a list, and every item is a known type', () => {
  const known = new Set(Object.keys(REGISTRY_FOR_DOCUMENT));
  for (const [category, types] of Object.entries(REQUIRED_DOCUMENTS)) {
    assert.ok(types.length > 0, category);
    for (const t of types) assert.ok(known.has(t), `${category}: ${t} has no registry mapping`);
  }
});

test('a policy list wins and is never merged with the table; an empty policy list is respected', () => {
  const policy = resolveRequiredDocuments('GENERAL_ENLISTMENT', ['NATIONAL_ID', 'NATIONAL_ID']);
  assert.deepEqual(policy, { source: 'POLICY_VERSION', types: ['NATIONAL_ID'] });
  assert.deepEqual(resolveRequiredDocuments('GENERAL_ENLISTMENT', []), { source: 'POLICY_VERSION', types: [] });
  const fallback = resolveRequiredDocuments('GENERAL_ENLISTMENT', undefined);
  assert.equal(fallback.source, 'GROUND_TRUTH_TABLE');
  assert.deepEqual([...fallback.types], [...REQUIRED_DOCUMENTS.GENERAL_ENLISTMENT].sort());
});

test('registry confirmation comes from REAL gate verdicts, never from the type alone', () => {
  const req = resolveRequiredDocuments('GENERAL_ENLISTMENT', undefined);
  const early = evaluateDocumentChecklist('GENERAL_ENLISTMENT', req, pending, []);
  const byType = (c: typeof early, t: DocumentType): string | undefined => c.items.find((i) => i.documentType === t)?.satisfaction;
  assert.equal(byType(early, 'NATIONAL_ID'), 'API_VERIFIED', 'NIDA identity is verified');
  assert.equal(byType(early, 'OLEVEL_CERTIFICATE'), 'MISSING', 'NESA has not passed yet');
  assert.equal(byType(early, 'NON_CONVICTION_CERTIFICATE'), 'MISSING', 'RIB has not cleared yet');
  const late = evaluateDocumentChecklist('GENERAL_ENLISTMENT', req, allPassed, []);
  assert.equal(byType(late, 'OLEVEL_CERTIFICATE'), 'API_VERIFIED');
  assert.equal(byType(late, 'NON_CONVICTION_CERTIFICATE'), 'API_VERIFIED');
  assert.equal(byType(late, 'GOOD_CONDUCT_CERTIFICATE'), 'MISSING', 'no registry confirms a sector certificate');
  assert.equal(late.complete, false);
});

test('an unverified identity does not satisfy the National ID item', () => {
  const req = resolveRequiredDocuments('GENERAL_ENLISTMENT', ['NATIONAL_ID']);
  const c = evaluateDocumentChecklist('GENERAL_ENLISTMENT', req, { ...pending, identityVerified: false }, []);
  assert.equal(c.items[0]?.satisfaction, 'MISSING');
});

test("the OTHER registry's verdict does not stand for this category's certificate", () => {
  // A degree category verifies through HEC, so a NESA-only fact must not count.
  const req = resolveRequiredDocuments('RESERVE_FORCE_UNIVERSITY', ['ALEVEL_CERTIFICATE']);
  const c = evaluateDocumentChecklist('RESERVE_FORCE_UNIVERSITY', req, allPassed, []);
  assert.equal(c.items[0]?.satisfaction, 'MISSING');
});

test('uploads: GREEN clears; AMBER is under review; RED or a human REJECT is rejected; CLEAR overrides amber', () => {
  const req = resolveRequiredDocuments('CADET_OFFICER', ['GOOD_CONDUCT_CERTIFICATE']);
  const state = (docs: StoredDocument[]): string | undefined =>
    evaluateDocumentChecklist('CADET_OFFICER', req, pending, docs).items[0]?.satisfaction;
  assert.equal(state([]), 'MISSING');
  assert.equal(state([doc('GOOD_CONDUCT_CERTIFICATE', { forensicsLane: 'GREEN' })]), 'UPLOADED_CLEARED');
  assert.equal(state([doc('GOOD_CONDUCT_CERTIFICATE', { forensicsLane: 'AMBER' })]), 'UNDER_REVIEW');
  assert.equal(state([doc('GOOD_CONDUCT_CERTIFICATE')]), 'UNDER_REVIEW', 'uploaded, forensics not yet run');
  assert.equal(state([doc('GOOD_CONDUCT_CERTIFICATE', { forensicsLane: 'RED' })]), 'REJECTED');
  assert.equal(state([doc('GOOD_CONDUCT_CERTIFICATE', { forensicsLane: 'AMBER', humanReviewDecision: 'REJECT' })]), 'REJECTED');
  assert.equal(state([doc('GOOD_CONDUCT_CERTIFICATE', { forensicsLane: 'AMBER', humanReviewDecision: 'CLEAR' })]), 'UPLOADED_CLEARED');
  assert.equal(state([doc('GOOD_CONDUCT_CERTIFICATE', { forensicsLane: 'GREEN', virusScanPassed: false })]), 'UNDER_REVIEW',
    'GREEN without a passed scan is not cleared');
  assert.equal(
    state([doc('GOOD_CONDUCT_CERTIFICATE', { forensicsLane: 'RED' }), doc('GOOD_CONDUCT_CERTIFICATE', { forensicsLane: 'GREEN' })]),
    'UPLOADED_CLEARED',
    'a re-upload that clears supersedes an earlier refusal',
  );
});

test('a complete checklist needs every item cleared', () => {
  const req = resolveRequiredDocuments('CADET_OFFICER', undefined);
  const docs = req.types
    .filter((t) => REGISTRY_FOR_DOCUMENT[t] === null)
    .map((t) => doc(t, { forensicsLane: 'GREEN' }));
  const c = evaluateDocumentChecklist('CADET_OFFICER', req, allPassed, docs);
  assert.equal(c.complete, true, JSON.stringify(c.items));
});

test('owner decision: the check-in officer clears a document by seeing it at the venue', () => {
  const req = resolveRequiredDocuments('GENERAL_ENLISTEE', ['CELIBACY_CERTIFICATE']);
  const c = evaluateDocumentChecklist('GENERAL_ENLISTEE', req, pending, [doc('CELIBACY_CERTIFICATE', { venueVerified: true })]);
  assert.equal(c.items[0]?.satisfaction, 'VENUE_VERIFIED');
  assert.equal(c.complete, true);
});

test('owner decision: an automated verification waives the paper even with nothing uploaded', () => {
  const req = resolveRequiredDocuments('CADET_OFFICER', ['NATIONAL_ID', 'DEGREE_DIPLOMA_COPY']);
  const c = evaluateDocumentChecklist('CADET_OFFICER', req, allPassed, []);
  assert.deepEqual(c.items.map((i) => i.satisfaction), ['API_VERIFIED', 'API_VERIFIED']);
  assert.equal(c.complete, true);
});

test('owner decision: a notarised diploma needs the upload AND THEN the registry — neither alone', () => {
  const req = resolveRequiredDocuments('OFFICER_ONE_YEAR', ['DEGREE_DIPLOMA_NOTARIZED']);
  const state = (gates: GateVerdicts, docs: StoredDocument[]): string | undefined =>
    evaluateDocumentChecklist('OFFICER_ONE_YEAR', req, gates, docs).items[0]?.satisfaction;
  assert.equal(state(allPassed, []), 'MISSING', 'HEC alone does not satisfy it');
  assert.equal(state(allPassed, [doc('DEGREE_DIPLOMA_NOTARIZED', { venueVerified: true })]), 'MISSING',
    'a venue sighting does not replace the upload');
  assert.equal(state(pending, [doc('DEGREE_DIPLOMA_NOTARIZED', { forensicsLane: 'GREEN' })]), 'AWAITING_REGISTRY');
  assert.equal(state(allPassed, [doc('DEGREE_DIPLOMA_NOTARIZED', { forensicsLane: 'GREEN' })]), 'UPLOADED_CLEARED');
  assert.equal(state(allPassed, [doc('DEGREE_DIPLOMA_NOTARIZED', { forensicsLane: 'AMBER' })]), 'UNDER_REVIEW');
  const item = evaluateDocumentChecklist('OFFICER_ONE_YEAR', req, allPassed, []).items[0];
  assert.equal(item?.registry, 'HEC', 'a degree category verifies through HEC');
});

test('the notarised item follows the CATEGORY registry (RCS General Enlistee is NESA-path)', () => {
  const req = resolveRequiredDocuments('GENERAL_ENLISTEE', ['DEGREE_DIPLOMA_NOTARIZED']);
  const c = evaluateDocumentChecklist('GENERAL_ENLISTEE', req, allPassed, [doc('DEGREE_DIPLOMA_NOTARIZED', { forensicsLane: 'GREEN' })]);
  assert.equal(c.items[0]?.registry, 'NESA');
  assert.equal(c.items[0]?.satisfaction, 'UPLOADED_CLEARED');
});

test("every announced requirement is a type its agency can actually store", () => {
  for (const [category, types] of Object.entries(REQUIRED_DOCUMENTS)) {
    const agency = agencyForCategory(category as ApplicationCategory);
    for (const t of types) assert.ok(AGENCY_DOCUMENT_TYPES[agency].has(t), `${category} (${agency}) requires ${t}`);
  }
});
