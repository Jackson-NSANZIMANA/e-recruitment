import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectChecklist } from '../src/adapters/http/document-checklist.controller.js';
import { projectAmberQueue } from '../src/adapters/http/projections.js';

const checklist = (clearance: unknown) => ({
  agency: 'RDF', source: 'GROUND_TRUTH_TABLE', complete: false,
  items: [{ documentType: 'NON_CONVICTION_CERTIFICATE', satisfaction: 'MISSING', registry: 'RIB', ...(clearance === undefined ? {} : { clearance }) }],
});

test('the officer sees the clearance state with its reasons; the citizen sees the state only', () => {
  const upstream = checklist({ state: 'UNDER_OFFICER_REVIEW', code: null, reasons: ['IDENTITY_NAME_PARTIAL'], holderName: 'LEAK' });
  const officer = projectChecklist(upstream, 'officer') as { items: { clearance: Record<string, unknown> }[] };
  assert.deepEqual(officer.items[0]?.clearance, { state: 'UNDER_OFFICER_REVIEW', code: null, reasons: ['IDENTITY_NAME_PARTIAL'] });
  const citizen = projectChecklist(upstream, 'citizen') as { items: { clearance: Record<string, unknown> }[] };
  assert.deepEqual(citizen.items[0]?.clearance, { state: 'UNDER_OFFICER_REVIEW', code: null });
  assert.equal(JSON.stringify(citizen).includes('LEAK'), false);
  assert.equal(JSON.stringify(citizen).includes('PARTIAL'), false);
});

test('an item without clearance is unchanged; a malformed clearance fails the whole projection', () => {
  const plain = projectChecklist(checklist(undefined)) as { items: Record<string, unknown>[] };
  assert.equal('clearance' in (plain.items[0] ?? {}), false);
  for (const bad of [null, { state: 'WHAT', code: null, reasons: [] }, { state: 'VERIFIED', code: 'lower', reasons: [] }, { state: 'VERIFIED', code: null, reasons: ['NOT_A_REASON'] }, 'x']) {
    assert.equal(projectChecklist(checklist(bad)), null);
  }
});

test('the amber queue carries closed reason codes only', () => {
  const rows = projectAmberQueue({ queue: [{ applicationId: 'a', processingCode: 'RDF-1', status: 'CRIMINAL_CLEARANCE', reasons: ['CLEARANCE_CONTENT_REVIEW', 'name is X', 'lower_case', 42] }, { applicationId: 'b' }] }, 'RDF');
  assert.deepEqual(rows[0]?.reasons, ['CLEARANCE_CONTENT_REVIEW']);
  assert.deepEqual(rows[1]?.reasons, []);
});

test('the citizen path (identity-service strips reasons) projects without them; the officer path still requires them', () => {
  const noReasons = checklist({ state: 'NUMBER_REQUIRED', code: null });
  const citizen = projectChecklist(noReasons, 'citizen') as { items: { clearance: Record<string, unknown> }[] } | null;
  assert.deepEqual(citizen?.items[0]?.clearance, { state: 'NUMBER_REQUIRED', code: null });
  assert.equal(projectChecklist(noReasons, 'officer'), null);
});
