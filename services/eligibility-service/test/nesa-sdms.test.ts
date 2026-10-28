// NesaSdmsGateway and the bind-then-evaluate gate on the captured SDMS shape
// (ADR-047, ADR-048 §2.2): the real nesa-sdms simulator in-process, no infra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxServer, DEFAULT_PROFILES, Population, silentLog, validateContract } from '@usrp/g2g-sandbox';
import { NesaSdmsGateway } from '../src/adapters/nesa.sdms-gateway.js';
import { HttpNesaSdmsTransport } from '../src/adapters/nesa.sdms-transport.js';
import { mapSdmsResults } from '../src/adapters/nesa.sdms-mapping.js';
import { decideNesaGate } from '../src/domain/nesa-binding.js';
import { evaluateNesaEducation } from '../src/domain/education-rules.js';
import { NesaUnavailableError } from '../src/domain/nesa.types.js';

const pop = new Population({ seed: 5, size: 10, referenceDate: new Date(Date.UTC(2026, 9, 25)) });
const GENEROUS = Object.fromEntries(Object.entries(DEFAULT_PROFILES).map(([k, v]) => [k, { ...v, bucketCapacity: 10_000 }])) as typeof DEFAULT_PROFILES;
const identityOf = (id: string) => {
  const c = pop.persona(id);
  return { fullName: `${c.surname} ${c.forename}`, dateOfBirth: c.dateOfBirth, sex: c.sex, nationalIdHint: `${c.nid.slice(0, 4)}${c.nid.slice(12)}` };
};

async function withGateway(run: (gateway: NesaSdmsGateway) => Promise<void>, env: Record<string, string> = { NODE_ENV: 'development' }): Promise<void> {
  const server = await createSandboxServer({
    world: { population: pop, overlay: null, live: null, now: () => new Date(), log: silentLog, clientTokens: new Set() },
    environment: 'development', port: 0, host: '127.0.0.1', latencyScale: 0, timeoutHoldMs: 100, profiles: GENEROUS,
  });
  try {
    await run(new NesaSdmsGateway({ transport: new HttpNesaSdmsTransport({ baseUrl: server.url, timeoutMs: 2_000 }), env }));
  } finally {
    await server.stop();
  }
}

test('every simulated record is on the captured contract and maps without a fault', async () => {
  await withGateway(async (gateway) => {
    for (const c of pop.citizens) {
      if (c.nesa === null || c.behaviour.nesa !== undefined) continue;
      assert.deepEqual(validateContract('sdms-results-by-index', c.nesa), [], c.key);
      const r = await gateway.lookupResults(c.nesa.studentIndexNumber);
      assert.equal(r.status, 'FOUND', c.key);
    }
  });
});

test('holder fields and levels: TVET→A2, O_LEVEL→O_LEVEL, examYear from academicYear', async () => {
  await withGateway(async (gateway) => {
    const legacy = await gateway.lookupResults('990301PCM0012024');
    assert.ok(legacy.status === 'FOUND');
    assert.equal(legacy.results.holder.name, 'UWIMANA Jean Pierre');
    assert.equal(legacy.results.holder.sex, 'MALE');
    assert.match(legacy.results.holder.nationalIdHint ?? '', /^1200\*{8}1000$/);
    assert.equal(legacy.results.qualificationLevel, 'A2');
    assert.equal(legacy.results.examYear, 2024);
    const tvet = await gateway.lookupResults(pop.persona('P-TVET-A2').nesa?.studentIndexNumber ?? '');
    assert.ok(tvet.status === 'FOUND' && tvet.results.levelType === 'TVET' && tvet.results.qualificationLevel === 'A2');
    const s3 = await gateway.lookupResults(pop.persona('P-S3-ONLY').nesa?.studentIndexNumber ?? '');
    assert.ok(s3.status === 'FOUND' && s3.results.qualificationLevel === 'O_LEVEL');
  });
});

test('404 is NOT_FOUND; 429, 503, truncation and a sandbox answer in production are faults', async () => {
  await withGateway(async (gateway) => {
    assert.equal((await gateway.lookupResults('990000ZZZ9992020')).status, 'NOT_FOUND');
    for (const id of ['P-NESA-429', 'P-NESA-503', 'P-NESA-TRUNCATED']) {
      await assert.rejects(gateway.lookupResults(pop.persona(id).nesa?.studentIndexNumber ?? ''), NesaUnavailableError, id);
    }
  });
  await withGateway(async (gateway) => {
    await assert.rejects(gateway.lookupResults('990301PCM0012024'), /SANDBOX simulator; refused in production/);
  }, { NODE_ENV: 'production' });
});

test('mapping refuses a record for a different index and malformed marks', () => {
  const record = pop.persona('L-01').nesa;
  assert.equal(mapSdmsResults(record, 'OTHER').kind, 'FAULT');
  assert.equal(mapSdmsResults({ ...record, rawMark: [{}] }, '990301PCM0012024').kind, 'FAULT');
  assert.equal(mapSdmsResults({ ...record, resultsAggregate: null }, '990301PCM0012024').kind, 'FOUND');
  const unknown = mapSdmsResults({ ...record, combinationLevelType: 'SOMETHING_NEW' }, '990301PCM0012024');
  assert.ok(unknown.kind === 'FOUND' && unknown.results.qualificationLevel === null);
});

test('mapping refuses missing or malformed SDMS holder identity fields', () => {
  const record = pop.persona('L-01').nesa;
  assert.ok(record !== null);
  const index = record.studentIndexNumber;
  assert.equal(mapSdmsResults({ ...record, gender: undefined }, index).kind, 'FAULT');
  assert.equal(mapSdmsResults({ ...record, studentNationalIdHint: undefined }, index).kind, 'FAULT');
  assert.equal(mapSdmsResults({ ...record, studentNationalIdHint: 'not-a-masked-hint' }, index).kind, 'FAULT');
  assert.equal(mapSdmsResults(record, index).kind, 'FOUND'); // no DOB field in SDMS contract
});

function decide(personaId: string, holderOf = personaId) {
  const mapped = mapSdmsResults(pop.persona(holderOf).nesa, pop.persona(holderOf).nesa?.studentIndexNumber ?? '');
  assert.ok(mapped.kind === 'FOUND');
  return decideNesaGate(identityOf(personaId), mapped.results);
}

test('gate: bind first; then unpublished, review, evaluate', () => {
  assert.equal(decide('L-01').kind, 'EVALUATE');
  assert.equal(decide('L-01', 'L-07').kind, 'NOT_BOUND'); // someone else's valid index
  assert.equal(decide('P-NESA-NAME-MISMATCH').kind, 'NOT_BOUND');
  assert.equal(decide('P-NESA-HINT-MISMATCH').kind, 'NOT_BOUND');
  assert.deepEqual(decide('P-NESA-NAME-PARTIAL'), { ...decide('P-NESA-NAME-PARTIAL'), kind: 'REVIEW', reasons: ['NAME_PARTIAL'] });
  assert.equal(decide('P-NESA-DIACRITICS').kind, 'EVALUATE');
  assert.equal(decide('P-NESA-UNPUBLISHED').kind, 'PENDING_UNPUBLISHED');
  const malpractice = decide('P-NESA-MALPRACTICE');
  assert.ok(malpractice.kind === 'REVIEW' && malpractice.reasons.includes('MALPRACTICE'));
});

test('gate: missing applicant-side NID hint yields REVIEW for SDMS binding', () => {
  const base = mapSdmsResults(pop.persona('L-01').nesa, '990301PCM0012024');
  assert.ok(base.kind === 'FOUND');
  const missingHint = decideNesaGate({ ...identityOf('L-01'), nationalIdHint: null }, base.results);
  assert.equal(missingHint.kind, 'REVIEW');
});

test('gate: an unknown level type or a non-PASS division is REVIEW, never automatic', () => {
  const base = mapSdmsResults(pop.persona('L-01').nesa, '990301PCM0012024');
  assert.ok(base.kind === 'FOUND');
  const level = decideNesaGate(identityOf('L-01'), { ...base.results, qualificationLevel: null, levelType: 'NEW' });
  assert.ok(level.kind === 'REVIEW' && level.reasons.includes('UNKNOWN_LEVEL_TYPE'));
  const division = decideNesaGate(identityOf('L-01'), { ...base.results, division: 'FAIL' });
  assert.ok(division.kind === 'REVIEW' && division.reasons.includes('DIVISION_NOT_PASS'));
});

test('gate: an identity without a stored NID hint (verified before rls/0042) is REVIEW, not bound on name and sex alone', () => {
  const base = mapSdmsResults(pop.persona('L-01').nesa, '990301PCM0012024');
  assert.ok(base.kind === 'FOUND');
  const withHint = decideNesaGate(identityOf('L-01'), base.results);
  assert.equal(withHint.kind, 'EVALUATE');
  const noHint = decideNesaGate({ ...identityOf('L-01'), nationalIdHint: null }, base.results);
  assert.ok(noHint.kind === 'REVIEW' && noHint.reasons.includes('NID_HINT_NOT_COMPARED'));
  assert.equal(noHint.binding.fields.nationalIdHint, 'NOT_COMPARED');
});

test('evaluation after binding: S3 meets RDF regular only; the RCS science bar uses weightedPercent', () => {
  const asOf = new Date('2026-10-25T00:00:00Z');
  const s3 = decide('P-S3-ONLY');
  assert.ok(s3.kind === 'EVALUATE');
  assert.equal(evaluateNesaEducation('GENERAL_ENLISTMENT', s3.facts, asOf).academicStatus, 'ELIGIBLE');
  assert.equal(evaluateNesaEducation('BASIC_POLICE_COURSE', s3.facts, asOf).academicStatus, 'INELIGIBLE');
  const ok = decide('P-ELIG-UR-SCI70');
  const low = decide('P-UR-SCI-69');
  assert.ok(ok.kind === 'EVALUATE' && low.kind === 'EVALUATE');
  assert.equal(evaluateNesaEducation('OFFICER_FOUR_YEAR_UR', ok.facts, asOf).academicStatus, 'ELIGIBLE');
  assert.equal(evaluateNesaEducation('OFFICER_FOUR_YEAR_UR', low.facts, asOf).academicStatus, 'INELIGIBLE');
});
