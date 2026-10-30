// The clearance flow on the real Irembo envelope (ADR-047/048): the irembo-certificates
// simulator in-process, the pure ordered checks, the use case with fakes. No infra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus, newCorrelationContext, newEnvelope } from '@usrp/shared-events';
import { createSandboxServer, DEFAULT_PROFILES, Population, silentLog, validateContract, DEV_G2G_CLIENT_TOKEN } from '@usrp/g2g-sandbox';
import {
  CLEARANCE_CONSUMER_GROUP,
  ClearanceRegistryUnavailableError,
  HttpIremboCertificateTransport,
  IremboCertificateGateway,
  VerifyClearanceCertificateService,
  clearanceDeadLetterObserver,
  decideClearance,
  isoFromDdMmYyyy,
  mapIremboCertificate,
  parseClearanceNumber,
  type ApplicantIdentityReader,
  type ClearancePolicy,
  type ClearanceVerificationRecord,
  type ClearanceVerificationRepository,
} from '../src/index.js';

const REFERENCE = new Date(Date.UTC(2026, 9, 25));
const TODAY = '2026-10-25';
const pop = new Population({ seed: 5, size: 10, referenceDate: REFERENCE });
const GENEROUS = Object.fromEntries(Object.entries(DEFAULT_PROFILES).map(([k, v]) => [k, { ...v, bucketCapacity: 10_000 }])) as typeof DEFAULT_PROFILES;
const NO_RECORD = 'SANDBOX_PLACEHOLDER_CRIMINAL_NO_RECORD';
const POLICY: ClearancePolicy = { allowedTypes: new Set([NO_RECORD, 'SANDBOX_PLACEHOLDER_CRIMINAL_RECORD_EXTRACT']), noRecordTypes: new Set([NO_RECORD]), validityDays: 90 };
const AGENCY_POLICY_NO_DISTINCT: ClearancePolicy = { ...POLICY, noRecordTypes: new Set() };

const identityOf = (persona: string) => {
  const c = pop.persona(persona);
  return { fullName: `${c.surname} ${c.forename}`, dateOfBirth: c.dateOfBirth, sex: c.sex, nationalIdHint: `${c.nid.slice(0, 4)}${c.nid.slice(12)}` };
};
const numberOf = (persona: string): string => pop.persona(persona).certificates[0]?.applicationNumber ?? '';

async function withGateway(run: (gateway: IremboCertificateGateway) => Promise<void>, env: Record<string, string> = { NODE_ENV: 'development' }): Promise<void> {
  const server = await createSandboxServer({
    world: { population: pop, overlay: null, live: null, now: () => new Date(), log: silentLog, clientTokens: new Set([DEV_G2G_CLIENT_TOKEN]) },
    environment: 'development', port: 0, host: '127.0.0.1', latencyScale: 0, timeoutHoldMs: 100, profiles: GENEROUS,
  });
  try {
    await run(new IremboCertificateGateway({ transport: new HttpIremboCertificateTransport({ baseUrl: server.url, clientToken: DEV_G2G_CLIENT_TOKEN, timeoutMs: 2_000 }), env }));
  } finally {
    await server.stop();
  }
}

test('number shape: a letter, 12 digits, 4 letters; spaces, hyphens and case are forgiven', () => {
  assert.equal(parseClearanceNumber(' s990000000001-abcd '), 'S990000000001ABCD');
  for (const bad of ['', 'S99000000000ABCD', '1990000000001ABCD', 'S990000000001ABC', 'S990000000001ABCDE', 'not a number']) assert.equal(parseClearanceNumber(bad), null, bad);
});

test('mapping: found, not found (3105, data null) and every other shape is a fault', () => {
  assert.equal(isoFromDdMmYyyy('31/02/2026'), null);
  assert.equal(isoFromDdMmYyyy('05/10/2026'), '2026-10-05');
  assert.equal(mapIremboCertificate({ status: false, responseCode: '3105', data: null }).kind, 'NOT_FOUND');
  assert.equal(mapIremboCertificate({ status: false, responseCode: '5000', data: null }).kind, 'FAULT');
  assert.equal(mapIremboCertificate({ status: false, responseCode: '3105', data: { x: 1 } }).kind, 'FAULT');
  assert.equal(mapIremboCertificate('x').kind, 'FAULT');
  assert.equal(mapIremboCertificate({ status: true, data: { NAME: 'A B' } }).kind, 'FAULT');
});

test('every persona certificate maps on the captured contract', async () => {
  await withGateway(async (gateway) => {
    for (const c of pop.citizens) {
      for (const cert of c.certificates) {
        if (c.behaviour['irembo-certificates'] !== undefined) continue;
        assert.deepEqual(validateContract('irembo-certificate-verification', {
          status: true, responseCode: '3104', message: 'x', responseEncrypted: false, traceId: 'abcdefgh',
          data: { ISSUED_ON: '01/01/2026', STATUS: cert.status, REFERENCE_NUMBER: cert.applicationNumber, SIGNED_BY: 's', DATE_OF_BIRTH: '01/01/2000', APPLICATION_CODE: cert.applicationCode, NAME: cert.name },
        }), [], c.key);
        const r = await gateway.verify(cert.applicationNumber);
        assert.equal(r.status, 'FOUND', c.key);
      }
    }
  });
});

test('the clearance matrix: each persona lands in its outcome', async () => {
  await withGateway(async (gateway) => {
    const outcome = async (persona: string, policy = POLICY) => decideClearance(await gateway.verify(numberOf(persona)), identityOf(persona), policy, TODAY);

    const valid = await outcome('P-CLEARANCE-VALID');
    assert.equal(valid.kind, 'CLEARED');

    const conviction = await outcome('P-CLEARANCE-CONVICTION');
    assert.deepEqual(conviction.kind === 'REVIEW' && conviction.reasons, ['CLEARANCE_CONTENT_REVIEW']);

    const wrong = await outcome('P-CLEARANCE-WRONG-TYPE');
    assert.deepEqual(wrong.kind === 'CORRECTION_NEEDED' && wrong.code, 'CERTIFICATE_WRONG_TYPE');

    const expired = await outcome('P-CLEARANCE-EXPIRED');
    assert.deepEqual(expired.kind === 'CORRECTION_NEEDED' && expired.code, 'CERTIFICATE_EXPIRED');

    for (const p of ['P-CLEARANCE-NAME-MISMATCH', 'P-CLEARANCE-DOB-MISMATCH']) {
      const d = await outcome(p);
      assert.deepEqual(d.kind === 'CORRECTION_NEEDED' && d.code, 'CERTIFICATE_NOT_BOUND', p);
    }

    const partial = await outcome('P-CLEARANCE-NAME-PARTIAL');
    assert.deepEqual(partial.kind === 'REVIEW' && partial.reasons, ['IDENTITY_NAME_PARTIAL']);

    // Default taken: without a distinct "no record" type, content review is human even for a clean one.
    const humanAlways = await outcome('P-CLEARANCE-VALID', AGENCY_POLICY_NO_DISTINCT);
    assert.deepEqual(humanAlways.kind === 'REVIEW' && humanAlways.reasons, ['CLEARANCE_CONTENT_REVIEW']);

    const missing = decideClearance(await gateway.verify('S990000000000ZZZZ'), identityOf('P-CLEARANCE-VALID'), POLICY, TODAY);
    assert.deepEqual(missing.kind === 'CORRECTION_NEEDED' && missing.code, 'CERTIFICATE_NOT_FOUND');
  });
});

test('a citizen who is not the holder learns nothing about another certificate (binding before type and window)', async () => {
  await withGateway(async (gateway) => {
    for (const other of ['P-CLEARANCE-WRONG-TYPE', 'P-CLEARANCE-EXPIRED', 'P-CLEARANCE-CONVICTION']) {
      const d = decideClearance(await gateway.verify(numberOf(other)), identityOf('P-CLEARANCE-VALID'), POLICY, TODAY);
      assert.deepEqual(d.kind === 'CORRECTION_NEEDED' && d.code, 'CERTIFICATE_NOT_BOUND', other);
    }
  });
});

test('a certificate never binds on name alone: an identity with no comparable date of birth goes to a human', () => {
  const found = { status: 'FOUND' as const, requestId: 'r', certificate: { authentic: true, type: NO_RECORD, issuedOn: '2026-10-20', holderName: 'KAMANZI Olivier', holderDob: '2004-01-01', reference: 'x' } };
  const noDob = decideClearance(found, { fullName: 'KAMANZI Olivier', dateOfBirth: 'unreadable', sex: 'MALE' as const, nationalIdHint: null }, POLICY, TODAY);
  assert.notEqual(noDob.kind, 'CLEARED');
});

test('the validity window: 90 days inclusive, a future date and an unreadable date are out', () => {
  const lookup = (issuedOn: string, authentic = true) => ({
    status: 'FOUND' as const, requestId: 'r',
    certificate: { authentic, type: NO_RECORD, issuedOn, holderName: 'KAMANZI Olivier', holderDob: '2004-01-01', reference: 'x' },
  });
  const id = { fullName: 'KAMANZI Olivier', dateOfBirth: '2004-01-01', sex: 'MALE' as const, nationalIdHint: null };
  const kind = (issuedOn: string) => { const d = decideClearance(lookup(issuedOn), id, POLICY, TODAY); return d.kind === 'CORRECTION_NEEDED' ? d.code : d.kind; };
  assert.equal(kind('2026-07-27'), 'CLEARED'); // 90 days
  assert.equal(kind('2026-07-26'), 'CERTIFICATE_EXPIRED'); // 91 days
  assert.equal(kind('2026-10-25'), 'CLEARED'); // same day
  assert.equal(kind('2026-10-26'), 'CERTIFICATE_EXPIRED'); // future-dated
  assert.equal(kind('garbage'), 'CERTIFICATE_EXPIRED');
  const withdrawn = decideClearance(lookup('2026-10-20', false), id, POLICY, TODAY);
  assert.deepEqual(withdrawn.kind === 'CORRECTION_NEEDED' && withdrawn.code, 'CERTIFICATE_NOT_VALID');
});

test('outages are faults, never verdicts: 429, 503, status:false, truncation, a sandbox answer in production', async () => {
  await withGateway(async (gateway) => {
    for (const p of ['P-CLEARANCE-429', 'P-CLEARANCE-503', 'P-CLEARANCE-STATUS-FALSE']) {
      await assert.rejects(gateway.verify(numberOf(p)), ClearanceRegistryUnavailableError, p);
    }
  });
  await withGateway(async (gateway) => {
    await assert.rejects(gateway.verify(numberOf('P-CLEARANCE-VALID')), /SANDBOX simulator/);
  }, { NODE_ENV: 'production' });
});

// ── the use case ──────────────────────────────────────────────────

function harness(policy = POLICY) {
  const bus = new InMemoryEventBus();
  const records: ClearanceVerificationRecord[] = [];
  const repository: ClearanceVerificationRepository = { record: (r) => { records.push(r); return Promise.resolve('RECORDED'); } };
  const reader = (persona: string, status: 'VERIFIED' | 'PENDING' = 'VERIFIED'): ApplicantIdentityReader => ({
    findBindingSubjectById: (id) => Promise.resolve(id === 'missing' ? null : { identityStatus: status, ...identityOf(persona) }),
  });
  return { bus, records, repository, reader, policy };
}
const COMMAND = { applicantId: 'a1', applicationId: 'app1', agency: 'RDF' as const, category: 'RDF_REGULAR' as const, referenceDate: TODAY };

test('use case: CLEARED emits the vetting event with the source, plus an audit; the record holds no value', async () => {
  const h = harness();
  await withGateway(async (gateway) => {
    const service = new VerifyClearanceCertificateService({ gateway, identityReader: h.reader('P-CLEARANCE-VALID'), repository: h.repository, eventBus: h.bus, policy: h.policy, referenceHmacKey: 'k'.repeat(32) });
    const number = numberOf('P-CLEARANCE-VALID');
    const out = await service.verify({ ...COMMAND, clearanceCertificateNumber: ` ${number.toLowerCase()} ` });
    assert.equal(out.kind, 'CLEARED');
    const vetting = h.bus.published.find((e) => e.eventType === 'RIB_VETTING_COMPLETED');
    assert.ok(vetting && vetting.eventType === 'RIB_VETTING_COMPLETED');
    assert.equal(vetting.clearanceStatus, 'CLEARED');
    assert.equal(vetting.source, 'IREMBO_CERTIFICATE');
    assert.ok(h.bus.published.some((e) => e.eventType === 'AUDIT_ENTRY' && e.action === 'CLEARANCE_CERTIFICATE_PASSED'));
    const record = h.records[0];
    assert.ok(record);
    assert.equal(record.referenceLast4, number.slice(-4));
    assert.match(record.referenceHmac, /^[0-9a-f]{64}$/);
    // Nothing identifying anywhere in what was recorded or emitted.
    const c = pop.persona('P-CLEARANCE-VALID');
    const everything = JSON.stringify({ events: h.bus.published, records: h.records });
    for (const secret of [c.surname, c.forename, c.dateOfBirth, c.nid, number]) assert.equal(everything.includes(secret), false, 'leak');
  });
});

test('use case: REVIEW emits UNDER_REVIEW with reasons; a correctable failure emits only an audit and a record', async () => {
  const h = harness();
  await withGateway(async (gateway) => {
    const mk = (persona: string) => new VerifyClearanceCertificateService({ gateway, identityReader: h.reader(persona), repository: h.repository, eventBus: h.bus, policy: h.policy, referenceHmacKey: 'k'.repeat(32) });
    const review = await mk('P-CLEARANCE-CONVICTION').verify({ ...COMMAND, clearanceCertificateNumber: numberOf('P-CLEARANCE-CONVICTION') });
    assert.deepEqual(review.kind === 'REVIEW_REQUIRED' && review.reasons, ['CLEARANCE_CONTENT_REVIEW']);
    const v = h.bus.published.find((e) => e.eventType === 'RIB_VETTING_COMPLETED');
    assert.ok(v && v.eventType === 'RIB_VETTING_COMPLETED' && v.clearanceStatus === 'UNDER_REVIEW' && v.reviewReasons?.[0] === 'CLEARANCE_CONTENT_REVIEW');

    const before = h.bus.published.length;
    const wrong = await mk('P-CLEARANCE-WRONG-TYPE').verify({ ...COMMAND, clearanceCertificateNumber: numberOf('P-CLEARANCE-WRONG-TYPE') });
    assert.deepEqual(wrong.kind === 'CORRECTION_NEEDED' && wrong.code, 'CERTIFICATE_WRONG_TYPE');
    const added = h.bus.published.slice(before);
    assert.deepEqual(added.map((e) => e.eventType), ['AUDIT_ENTRY'], 'no vetting event: a correctable failure is not a verdict');
    assert.equal(h.records.at(-1)?.outcome, 'CORRECTION_NEEDED');
  });
});

test('use case: an outage records PENDING, emits nothing, and rethrows for the retry', async () => {
  const h = harness();
  await withGateway(async (gateway) => {
    const service = new VerifyClearanceCertificateService({ gateway, identityReader: h.reader('P-CLEARANCE-503'), repository: h.repository, eventBus: h.bus, policy: h.policy, referenceHmacKey: 'k'.repeat(32) });
    await assert.rejects(service.verify({ ...COMMAND, clearanceCertificateNumber: numberOf('P-CLEARANCE-503') }), ClearanceRegistryUnavailableError);
    assert.equal(h.bus.published.length, 0);
    assert.deepEqual([h.records[0]?.outcome, h.records[0]?.failureCode], ['PENDING', 'REGISTRY_UNAVAILABLE']);
  });
});

test('use case: malformed number, unknown applicant and unverified identity are return values', async () => {
  const h = harness();
  await withGateway(async (gateway) => {
    const gw = { verify: () => { throw new Error('must not be called'); } };
    const service = new VerifyClearanceCertificateService({ gateway: gw, identityReader: h.reader('P-CLEARANCE-VALID'), repository: h.repository, eventBus: h.bus, policy: h.policy, referenceHmacKey: 'k'.repeat(32) });
    const bad = await service.verify({ ...COMMAND, clearanceCertificateNumber: 'nope' });
    assert.deepEqual(bad.kind === 'CORRECTION_NEEDED' && bad.code, 'CERTIFICATE_NUMBER_MALFORMED');
    assert.equal((await service.verify({ ...COMMAND, applicantId: 'missing', clearanceCertificateNumber: 'S990000000000ZZZZ' })).kind, 'APPLICANT_NOT_FOUND');
    const unverified = new VerifyClearanceCertificateService({ gateway, identityReader: h.reader('P-CLEARANCE-VALID', 'PENDING'), repository: h.repository, eventBus: h.bus, policy: h.policy, referenceHmacKey: 'k'.repeat(32) });
    assert.equal((await unverified.verify({ ...COMMAND, clearanceCertificateNumber: 'S990000000000ZZZZ' })).kind, 'IDENTITY_NOT_VERIFIED');
  });
});

// ── the terminal word (evaluation D2) ─────────────────────────────
//
// The retry budget is ~15.5s by design, so a longer registry outage used to end
// on the dead-letter topic: the PENDING row stayed the latest word, the citizen
// kept reading "we are verifying", and no officer was ever asked. The escalation
// is the honest end of that path — a human, not another silent attempt.

test('escalation: REVIEW + CLEARANCE_UNVERIFIED, UNDER_REVIEW emitted, nothing about the certificate asserted', async () => {
  const h = harness();
  // A gateway that would answer is deliberate: escalation must never call it.
  const gateway = { verify: () => { throw new Error('the registry must not be consulted again'); } };
  const service = new VerifyClearanceCertificateService({ gateway, identityReader: h.reader('P-CLEARANCE-503'), repository: h.repository, eventBus: h.bus, policy: h.policy, referenceHmacKey: 'k'.repeat(32) });
  const number = numberOf('P-CLEARANCE-VALID');

  const outcome = await service.escalateUnverified({ ...COMMAND, clearanceCertificateNumber: number });
  assert.equal(outcome.kind, 'REVIEW_REQUIRED');
  assert.deepEqual(outcome.kind === 'REVIEW_REQUIRED' && outcome.reasons, ['CLEARANCE_UNVERIFIED']);

  const [record] = h.records;
  assert.ok(record);
  assert.equal(record.outcome, 'REVIEW');
  assert.deepEqual(record.reviewReasons, ['CLEARANCE_UNVERIFIED']);
  // Cause-neutral: no failure code, no certificate field, no binding guesswork.
  assert.deepEqual([record.failureCode, record.certificateType, record.issuedOn, record.binding], [null, null, null, null]);
  // The handle is the SAME as an attempt would have written, so one certificate
  // keeps one history (the escalation must not look like a second certificate).
  assert.equal(record.referenceLast4, number.slice(-4));
  assert.match(record.referenceHmac, /^[0-9a-f]{64}$/);

  const vetting = h.bus.published.find((e) => e.eventType === 'RIB_VETTING_COMPLETED');
  assert.ok(vetting && vetting.eventType === 'RIB_VETTING_COMPLETED');
  assert.equal(vetting.clearanceStatus, 'UNDER_REVIEW');
  assert.deepEqual(vetting.reviewReasons, ['CLEARANCE_UNVERIFIED']);
  assert.equal(vetting.source, 'IREMBO_CERTIFICATE');
  // The audit trail names the escalation, not a review the registry never asked for.
  assert.ok(h.bus.published.some((e) => e.eventType === 'AUDIT_ENTRY' && e.action === 'CLEARANCE_VERIFICATION_ESCALATED'));

  // Nothing identifying reaches a record, an event or a log payload.
  const c = pop.persona('P-CLEARANCE-503');
  const everything = JSON.stringify({ events: h.bus.published, records: h.records });
  for (const secret of [c.surname, c.forename, c.dateOfBirth, c.nid, number]) assert.equal(everything.includes(secret), false, 'leak');
});

test('dead-letter observer: only a registry outage for OUR group is escalated; every other give-up is left alone', async () => {
  const h = harness();
  const service = new VerifyClearanceCertificateService({ gateway: { verify: () => { throw new Error('unused'); } }, identityReader: h.reader('P-CLEARANCE-503'), repository: h.repository, eventBus: h.bus, policy: h.policy, referenceHmacKey: 'k'.repeat(32) });
  const observer = clearanceDeadLetterObserver(service);
  const event = {
    ...newEnvelope(newCorrelationContext()),
    eventType: 'CLEARANCE_CERTIFICATE_SUBMITTED' as const,
    applicantId: 'a1',
    applicationId: 'app1',
    agency: 'RDF' as const,
    category: 'RDF_REGULAR' as const,
    clearanceCertificateNumber: numberOf('P-CLEARANCE-VALID'),
    referenceDate: TODAY,
  };
  const info = (overrides: Partial<{ groupId: string; error: unknown }> = {}): Parameters<typeof observer>[1] => ({
    reason: 'HANDLER_FAILED', groupId: CLEARANCE_CONSUMER_GROUP, topic: 'clearance.submitted',
    partition: 0, offset: '1', attempts: 6, error: new ClearanceRegistryUnavailableError('outage'),
    ...overrides,
  });

  // Another consumer group on the same bus: not ours to answer.
  await observer(event, info({ groupId: 'someone-else' }));
  assert.equal(h.records.length, 0, 'a sibling group\'s dead letter must not touch our record');

  // A terminal failure that is NOT the outage path may already have written a
  // verdict; layering REVIEW over it would regress a cleared citizen.
  await observer(event, info({ error: new Error('publish failed') }));
  assert.equal(h.records.length, 0, 'only the outage path escalates');

  await observer(event, info());
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0]?.outcome, 'REVIEW');
});
