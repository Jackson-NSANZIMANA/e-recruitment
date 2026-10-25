// NidaIremboGateway on the captured IremboGov shapes (ADR-047): driven by the
// real nida-irembo simulator in-process (no infrastructure), plus the pure
// mapping on hand-built envelopes and the production response fence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxServer, DEFAULT_PROFILES, Population, silentLog } from '@usrp/g2g-sandbox';

const GENEROUS = Object.fromEntries(Object.entries(DEFAULT_PROFILES).map(([k, v]) => [k, { ...v, bucketCapacity: 10_000 }])) as typeof DEFAULT_PROFILES;
import { NidaIremboGateway } from '../src/adapters/nida.irembo-gateway.js';
import { HttpNidaIremboTransport, type NidaIremboTransport } from '../src/adapters/nida.irembo-transport.js';
import { mapIremboIdentity } from '../src/adapters/nida.irembo-mapping.js';
import { NidaUnavailableError } from '../src/domain/identity.errors.js';

const TOKEN = 'identity-test-client-token';
const pop = new Population({ seed: 3, size: 10, referenceDate: new Date(Date.UTC(2026, 9, 25)) });

async function withSimulator(run: (gateway: NidaIremboGateway, url: string) => Promise<void>, env: Record<string, string> = { NODE_ENV: 'development' }): Promise<void> {
  const server = await createSandboxServer({
    world: { population: pop, overlay: null, live: null, now: () => new Date(), log: silentLog, clientTokens: new Set([TOKEN]) },
    environment: 'development', port: 0, host: '127.0.0.1', latencyScale: 0, timeoutHoldMs: 200, profiles: GENEROUS,
  });
  try {
    const gateway = new NidaIremboGateway({ transport: new HttpNidaIremboTransport({ baseUrl: server.url, clientToken: TOKEN, timeoutMs: 2_000 }), subjectHmacSecret: 'subject-secret-for-tests', env });
    await run(gateway, server.url);
  } finally {
    await server.stop();
  }
}

test('FOUND: every mapped field, DD/MM/YYYY → ISO, SURNAME Forename, province derived', async () => {
  await withSimulator(async (gateway) => {
    const legacy = pop.persona('L-01');
    const result = await gateway.lookupCitizen(legacy.nid);
    assert.equal(result.status, 'FOUND');
    if (result.status !== 'FOUND') return;
    assert.deepEqual(result.citizen, {
      fullName: 'UWIMANA Jean Pierre', dateOfBirth: '2003-03-15', gender: 'MALE', homeDistrict: 'GASABO',
      homeProvince: 'KIGALI_CITY', citizenshipStatus: 'RWANDAN_CITIZEN', idDocumentExpired: false,
    });
    assert.equal(result.nidaLookupHash.length, 64);
    assert.equal(result.matchConfidence, null);
  });
});

test('every catalogue persona with a normal NIDA behaviour maps without a fault', async () => {
  await withSimulator(async (gateway) => {
    for (const c of pop.citizens) {
      if (c.behaviour.nida !== undefined) continue;
      const result = await gateway.lookupCitizen(c.nid);
      assert.equal(result.status, 'FOUND', c.key);
    }
  });
});

test('quirks: expired card is a flag, a non-NORMAL status or foreign nationality is not a citizen', async () => {
  await withSimulator(async (gateway) => {
    const expired = await gateway.lookupCitizen(pop.persona('P-ID-EXPIRED').nid);
    assert.ok(expired.status === 'FOUND' && expired.citizen.idDocumentExpired === true && expired.citizen.citizenshipStatus === 'RWANDAN_CITIZEN');
    const status = await gateway.lookupCitizen(pop.persona('P-CITIZEN-STATUS-OTHER').nid);
    assert.ok(status.status === 'FOUND' && status.citizen.citizenshipStatus === 'CITIZEN_STATUS_SUSPENDED');
    const foreign = await gateway.lookupCitizen(pop.persona('P-NON-CITIZEN').nid);
    assert.ok(foreign.status === 'FOUND' && foreign.citizen.citizenshipStatus === 'NON_CITIZEN');
  });
});

test('NOT_FOUND is a return value; every fault throws NidaUnavailableError', async () => {
  await withSimulator(async (gateway) => {
    assert.equal((await gateway.lookupCitizen('1200389999999000')).status, 'NOT_FOUND');
    for (const id of ['P-NIDA-429', 'P-NIDA-503', 'P-NIDA-STATUS-FALSE']) {
      await assert.rejects(gateway.lookupCitizen(pop.persona(id).nid), NidaUnavailableError, id);
    }
  });
});

test('a bad client credential is a fault, never NOT_FOUND', async () => {
  await withSimulator(async (_gateway, url) => {
    const wrong = new NidaIremboGateway({ transport: new HttpNidaIremboTransport({ baseUrl: url, clientToken: 'wrong-token-wrong-token', timeoutMs: 2_000 }), subjectHmacSecret: 's', env: { NODE_ENV: 'development' } });
    await assert.rejects(wrong.lookupCitizen(pop.persona('L-01').nid), NidaUnavailableError);
  });
});

test('FENCE 2: a production process refuses the simulator answer', async () => {
  await withSimulator(async (gateway) => {
    await assert.rejects(gateway.lookupCitizen(pop.persona('L-01').nid), /SANDBOX simulator; refused in production/);
  }, { NODE_ENV: 'production' });
});

test('a truncated body and a malformed NID are handled before any verdict', async () => {
  const truncated: NidaIremboTransport = { fetchIdentity: async () => ({ status: 200, headers: new Headers(), bodyText: '{"status":true,"da' }) };
  const gateway = new NidaIremboGateway({ transport: truncated, subjectHmacSecret: 's', env: {} });
  await assert.rejects(gateway.lookupCitizen('1200389990001000'), /truncated/);
  await assert.rejects(gateway.lookupCitizen('not-a-nid'));
});

test('mapping: unknown status:false is a fault; reshaped records are faults; province must agree', () => {
  assert.equal(mapIremboIdentity({ status: false, responseCode: 'USER_PROFILE_NOT_FOUND' }, '2026-10-25').kind, 'NOT_FOUND');
  assert.equal(mapIremboIdentity({ status: false, responseCode: 'INTERNAL_SERVER_ERROR' }, '2026-10-25').kind, 'FAULT');
  assert.equal(mapIremboIdentity({ data: {} }, '2026-10-25').kind, 'FAULT');
  const info = { surname: 'KAMANZI', forename: 'Eric', dateOfBirth: '15/03/2003', sex: 'MALE', district: 'Gasabo', province: 'Amajyepfo', nationality: 'RW', citizenStatus: 'NORMAL', dateOfExpiry: '01/01/2030' };
  assert.equal(mapIremboIdentity({ status: true, data: { identityInfo: info } }, '2026-10-25').kind, 'FAULT');
  assert.equal(mapIremboIdentity({ status: true, data: { identityInfo: { ...info, province: 'Umujyi wa Kigali' } } }, '2026-10-25').kind, 'FOUND');
  assert.equal(mapIremboIdentity({ status: true, data: { identityInfo: { ...info, province: 'Kigali City', dateOfBirth: '31/02/2003' } } }, '2026-10-25').kind, 'FAULT');
});
