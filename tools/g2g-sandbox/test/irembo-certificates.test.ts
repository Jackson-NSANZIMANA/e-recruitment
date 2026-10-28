import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContract } from '../src/contracts.js';
import { APPLICATION_NUMBER_HEADER, APPLICATION_NUMBER_PATTERN, CERT_CODES, IREMBO_CERTIFICATE_PATH } from '../src/modules/irembo-certificates.js';
import { CERTIFICATE_APPLICATION_CODES } from '../src/population/model.js';
import { startSandbox, TOKEN } from './helpers.js';

const verify = (base: string, number: string, extra: Record<string, string> = {}, token: string | null = TOKEN) =>
  fetch(`${base}${IREMBO_CERTIFICATE_PATH}`, { headers: { [APPLICATION_NUMBER_HEADER]: number, ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...extra } });

test('every persona certificate validates against the captured contract, in the real envelope', async () => {
  const { server, pop } = await startSandbox();
  try {
    let seen = 0;
    for (const c of pop.citizens) {
      for (const cert of c.certificates) {
        seen += 1;
        assert.match(cert.applicationNumber, APPLICATION_NUMBER_PATTERN);
        if (c.behaviour['irembo-certificates'] !== undefined) continue;
        const r = await verify(server.url, cert.applicationNumber);
        assert.equal(r.status, 200, c.key);
        assert.equal(r.headers.get('x-usrp-sandbox'), '1');
        const body = (await r.json()) as { responseCode: string; message: string; data: Record<string, unknown> };
        assert.deepEqual(validateContract('irembo-certificate-verification', body), [], c.key);
        assert.equal(body.responseCode, CERT_CODES.FOUND.code);
        assert.equal(body.message, 'Dosiye yabonetse');
        assert.equal(body.data['APPLICATION_CODE'], CERTIFICATE_APPLICATION_CODES[cert.kind]);
      }
    }
    assert.ok(seen >= 9, 'the clearance personas carry certificates');
  } finally {
    await server.stop();
  }
});

test('the contract check is not vacuous for certificates', async () => {
  const { server, pop } = await startSandbox();
  try {
    const cert = pop.persona('P-CLEARANCE-VALID').certificates[0];
    const body = (await (await verify(server.url, cert?.applicationNumber ?? '')).json()) as { data: Record<string, unknown> };
    assert.ok(validateContract('irembo-certificate-verification', { ...body, extra: 1 }).length > 0);
    assert.ok(validateContract('irembo-certificate-verification', { ...body, data: { ...body.data, ISSUED_ON: '2026-10-01' } }).length > 0);
  } finally {
    await server.stop();
  }
});

test('personas answer with the facts their scenario needs', async () => {
  const { server, pop } = await startSandbox();
  try {
    const read = async (id: string): Promise<Record<string, unknown>> => {
      const cert = pop.persona(id).certificates[0];
      return ((await (await verify(server.url, cert?.applicationNumber ?? '')).json()) as { data: Record<string, unknown> }).data;
    };
    assert.equal((await read('P-CLEARANCE-VALID'))['APPLICATION_CODE'], CERTIFICATE_APPLICATION_CODES.NO_RECORD);
    assert.equal((await read('P-CLEARANCE-CONVICTION'))['APPLICATION_CODE'], CERTIFICATE_APPLICATION_CODES.RECORD_EXTRACT);
    assert.equal((await read('P-CLEARANCE-WRONG-TYPE'))['APPLICATION_CODE'], CERTIFICATE_APPLICATION_CODES.EQUIVALENCE);
    const expired = await read('P-CLEARANCE-EXPIRED');
    const fresh = await read('P-CLEARANCE-VALID');
    const dayOf = (v: unknown): number => { const [d, m, y] = String(v).split('/').map(Number); return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1); };
    assert.ok(dayOf(fresh['ISSUED_ON']) - dayOf(expired['ISSUED_ON']) > 150 * 86_400_000);
    assert.notEqual((await read('P-CLEARANCE-DOB-MISMATCH'))['DATE_OF_BIRTH'], undefined);
  } finally {
    await server.stop();
  }
});

test('not found, malformed number, credential, and registry failures are told apart', async () => {
  const { server, pop } = await startSandbox();
  try {
    const missing = await verify(server.url, 'A000000000000ZZZZ');
    const missingBody = (await missing.json()) as { status: boolean; responseCode: string; data: unknown };
    assert.equal(missing.status, 200);
    assert.deepEqual([missingBody.status, missingBody.responseCode, missingBody.data], [false, CERT_CODES.NOT_FOUND.code, null]);

    assert.equal((await verify(server.url, 'not-a-number')).status, 400);
    assert.equal((await verify(server.url, 'S000000000000AAAA', {}, null)).status, 401);
    assert.equal((await verify(server.url, 'S000000000000AAAA', {}, 'wrong')).status, 401);

    const number = (id: string): string => pop.persona(id).certificates[0]?.applicationNumber ?? '';
    const limited = await verify(server.url, number('P-CLEARANCE-429'));
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after') !== null);
    assert.equal((await verify(server.url, number('P-CLEARANCE-503'))).status, 503);
    const failed = (await (await verify(server.url, number('P-CLEARANCE-STATUS-FALSE'))).json()) as { status: boolean; responseCode: string };
    assert.deepEqual([failed.status, failed.responseCode], [false, CERT_CODES.FAILED.code]);
    // Per-request override works on any number.
    assert.equal((await verify(server.url, number('P-CLEARANCE-VALID'), { 'x-usrp-sandbox-behaviour': 'maintenance' })).status, 503);
  } finally {
    await server.stop();
  }
});

test('no value of the third-party sample is in the catalogue (shape only)', async () => {
  const { pop } = await startSandbox().then(async (s) => { await s.server.stop(); return s; });
  for (const c of pop.citizens) for (const cert of c.certificates) {
    assert.match(cert.applicationNumber, /^S99[0-9]{10}[A-Z]{4}$/, 'sandbox block only');
    assert.equal(cert.signedBy, 'SANDBOX SYNTHETIC REGISTRAR');
  }
});
