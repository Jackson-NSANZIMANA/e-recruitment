// ══════════════════════════════════════════════════════════════════
// Single-use admission at the venue gate — LIVE, end to end (BUILD-003, ADR-034)
//
// The real identity-service front door (hashes the card's national ID, forwards
// under the officer's OWN token) → the real application-service route (decides,
// as the officer's agency DB role) → real PostgreSQL (rls/0032). Proves:
//
//   1. a genuine ticket + matching card at the right gate on the exam day is
//      ADMITTED once: admission row, SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED,
//      attributed history, audit staged, every attempt logged;
//   2. the QR is SINGLE-USE: a second scan — same officer, another officer,
//      another gate — is ALREADY_ADMITTED; eight simultaneous scans of a fresh
//      QR admit exactly one;
//   3. impostor, forgery, wrong gate, wrong day, wrong agency, unknown ticket,
//      withdrawn candidate: each refused with its own code, nothing admitted;
//   4. only the screening post may admit; the raw national ID never leaves
//      identity-service; the citizen's QR page then shows ADMITTED, never the QR;
//   5. the records are append-only and agency-isolated in the engine itself.
//
//   bash scripts/run-selfchecks.sh   (or: proof.sh services/identity-service/selfcheck/verify-gate-admission.ts)
// ══════════════════════════════════════════════════════════════════

import { createPublicKey } from 'node:crypto';
import postgres from 'postgres';
import { InMemoryEventBus } from '@usrp/shared-events';
import { startHttpServer } from '@usrp/shared-http';
import { generateDeviceKeyPair, hashNationalId, signSlotInvitation } from '@usrp/shared-security';
import { makeAuthVerifier, signAuthToken, type AuthTokenClaims } from '@usrp/shared-auth';
import type { Agency, SlotInvitationClaims } from '@usrp/shared-types';

// One in-test issuer keypair for both services (before any config is loaded).
const KEYS = generateDeviceKeyPair();
process.env['AUTH_JWT_PRIVATE_KEY_B64'] = Buffer.from(KEYS.privateKeyPem, 'utf8').toString('base64');
process.env['AUTH_JWT_PUBLIC_KEY_B64'] = Buffer.from(
  createPublicKey(KEYS.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString(),
  'utf8',
).toString('base64');

const { createApplicationService, loadApplicationConfig, gateAdmissionRoutes: appGateRoutes, examInvitationRoute, kigaliDate } =
  await import('@usrp/application-service');
const { loadIdentityConfig, gateAdmissionRoutes: idGateRoutes, HttpGateAdmissionGateway } = await import('../src/index.js');

const ADMIN_URL =
  process.env['ADMIN_DATABASE_URL'] ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });

// ── Fixtures (ga000000 — unique to this proof) ────────────────────
const QR_KEY = generateDeviceKeyPair(); // stands in for scheduling's invitation key
const CAMPAIGN = 'a9000000-0000-4000-8000-0000000000c1';
const RNP_CAMPAIGN = 'a9000000-0000-4000-8000-0000000000c2';
const SLOT = 'a9000000-0000-4000-8000-0000000000e1';
const VENUE = 'IPRC Kicukiro Stadium';
const OFFICER_A = 'a9000000-0000-4000-8000-00000000ff01';
const OFFICER_B = 'a9000000-0000-4000-8000-00000000ff02';
const OFFICER_MED = 'a9000000-0000-4000-8000-00000000ff03';
const OFFICER_RNP = 'a9000000-0000-4000-8000-00000000ff04';
const OFFICERS = [OFFICER_A, OFFICER_B, OFFICER_MED, OFFICER_RNP];

interface Candidate {
  readonly applicant: string;
  readonly app: string;
  readonly nid: string;
  readonly code: string;
  readonly status: string;
  readonly examOffsetDays: number;
  readonly agency: Agency;
}
const c = (n: number, status: string, examOffsetDays = 0, agency: Agency = 'RDF'): Candidate => ({
  applicant: `a9000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  app: `a9000000-0000-4000-8000-00000000a0${String(n).padStart(2, '0')}`,
  nid: `11999${String(n).padStart(2, '0')}000000000`.slice(0, 16),
  code: `${agency}-981${String(n).padStart(2, '0')}`,
  status,
  examOffsetDays,
  agency,
});
const OK = c(1, 'SLOT_ASSIGNED');
const RACE = c(2, 'SLOT_ASSIGNED');
const IMPOSTOR = c(3, 'SLOT_ASSIGNED');
const EARLY = c(4, 'SLOT_ASSIGNED', +1);
const LATE = c(5, 'SLOT_ASSIGNED', -1);
const WITHDRAWN = c(6, 'WITHDRAWN');
const SCHEDULED = c(7, 'PHYSICAL_TEST_SCHEDULED');
const RNP = c(8, 'SLOT_ASSIGNED', 0, 'RNP');
const RDF_ALL = [OK, RACE, IMPOSTOR, EARLY, LATE, WITHDRAWN, SCHEDULED];
const ALL = [...RDF_ALL, RNP];

const DAY_MS = 86_400_000;
const examDateFor = (offset: number): string => kigaliDate(new Date(Date.now() + offset * DAY_MS));
const nextUtcMidnight = (date: string): string => new Date(Date.parse(`${date}T00:00:00.000Z`) + DAY_MS).toISOString();

function mint(x: Candidate, overrides: Partial<SlotInvitationClaims> = {}): string {
  const examDate = examDateFor(x.examOffsetDays);
  const claims: SlotInvitationClaims = {
    v: 1, keyId: 'selfcheck-qr', ticketId: `GA-TKT-${x.app.slice(-4)}`, applicationId: x.app, applicantId: x.applicant,
    agency: x.agency, campaignId: x.agency === 'RDF' ? CAMPAIGN : RNP_CAMPAIGN, slotId: SLOT, venueName: VENUE,
    examDate, reportingTimeHour: 8, issuedAt: new Date().toISOString(), expiresAt: nextUtcMidnight(examDate), ...overrides,
  };
  return signSlotInvitation(QR_KEY.privateKeyPem, claims);
}
const TOKENS = new Map(ALL.map((x) => [x.app, mint(x)]));
const tokenOf = (x: Candidate): string => TOKENS.get(x.app)!;

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const s of ['rdf_ops', 'rnp_ops'] as const) {
      await tx`DELETE FROM ${tx(s)}.gate_admission_attempts WHERE officer_id IN ${tx(OFFICERS)}`;
      await tx`DELETE FROM ${tx(s)}.gate_admissions WHERE application_id IN ${tx(ALL.map((x) => x.app))}`;
      await tx`DELETE FROM ${tx(s)}.application_status_history WHERE application_id IN ${tx(ALL.map((x) => x.app))}`;
      await tx`DELETE FROM ${tx(s)}.applications WHERE id IN ${tx(ALL.map((x) => x.app))}`;
    }
    await tx`DELETE FROM public_core.event_outbox WHERE payload->>'entityId' IN ${tx(ALL.map((x) => x.app))}`;
    await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx([CAMPAIGN, RNP_CAMPAIGN])}`;
    await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx(ALL.map((x) => x.applicant))}`;
  });
}

async function seed(hmacKey: string): Promise<void> {
  await admin.begin(async (tx) => {
    for (const x of ALL) {
      await tx`INSERT INTO public_core.applicant_identities
        (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth, encrypted_home_district,
         encrypted_home_province, gender, registration_channel, identity_status)
        VALUES (${x.applicant}, ${hashNationalId(x.nid, hmacKey)}, 'x','x','x','x','MALE','WEB',
                'VERIFIED'::public_core.identity_verification_status)`;
    }
    await tx`SET LOCAL session_replication_role = replica`;
    for (const [id, agency, code, category] of [
      [CAMPAIGN, 'RDF', 'RDF-GATE-SELFCHECK', 'GENERAL_ENLISTMENT'],
      [RNP_CAMPAIGN, 'RNP', 'RNP-GATE-SELFCHECK', 'BASIC_POLICE_COURSE'],
    ] as const) {
      await tx`INSERT INTO public_core.recruitment_campaigns
        (id, public_code, campaign_label, agency, status, target_categories, registration_opens_at,
         registration_closes_at, examination_start_date, examination_end_date, examination_reporting_hour)
        VALUES (${id}, ${code}, ${`${code} label`}, ${agency}, 'REGISTRATION_CLOSED', ${JSON.stringify([category])},
                now() - interval '30 days', now() - interval '1 day', ${examDateFor(-1)}, ${examDateFor(1)}, 8)`;
    }
    for (const x of RDF_ALL) {
      await tx`INSERT INTO rdf_ops.applications
        (id, processing_code, applicant_id, campaign_id, category, status, qr_invitation_code, qr_signed_token, assigned_venue_name)
        VALUES (${x.app}, ${x.code}, ${x.applicant}, ${CAMPAIGN}, 'GENERAL_ENLISTMENT',
                ${x.status}::rdf_ops.application_status, ${`GA-TKT-${x.app.slice(-4)}`}, ${tokenOf(x)}, ${VENUE})`;
    }
    await tx`INSERT INTO rnp_ops.applications
      (id, processing_code, applicant_id, campaign_id, category, status, qr_invitation_code, qr_signed_token, assigned_venue_name)
      VALUES (${RNP.app}, ${RNP.code}, ${RNP.applicant}, ${RNP_CAMPAIGN}, 'BASIC_POLICE_COURSE',
              'SLOT_ASSIGNED'::rnp_ops.application_status, ${`GA-TKT-${RNP.app.slice(-4)}`}, ${tokenOf(RNP)}, ${VENUE})`;
  });
}

async function main(): Promise<void> {
  console.log('\n══ Gate admission — single-use QR at the venue gate (LIVE, BUILD-003 / ADR-034) ══');
  const appConfig = loadApplicationConfig();
  const idConfig = loadIdentityConfig();
  await cleanup();
  await seed(idConfig.security.nationalIdHmacKey);

  const appBus = new InMemoryEventBus();
  const appService = createApplicationService(appConfig, appBus);
  const appVerify = makeAuthVerifier({ publicKeyPem: appConfig.auth.authPublicKeyPem, issuer: appConfig.auth.jwtIssuer, audience: appConfig.auth.jwtAudience });
  const appServer = await startHttpServer({
    serviceName: 'application-gate-selfcheck', port: 0, host: '127.0.0.1', handleSignals: false,
    routes: [...appGateRoutes(appService.gateAdmission, appVerify), examInvitationRoute(appService.examInvitation, appVerify)],
  });

  // A spy in front of the real gateway: what exactly leaves identity-service?
  const forwarded: string[] = [];
  const realGateway = new HttpGateAdmissionGateway({ applicationBaseUrl: appServer.url });
  const spyGateway: typeof realGateway = Object.assign(Object.create(Object.getPrototypeOf(realGateway) as object) as typeof realGateway, {
    admit: (bearer: string, request: Parameters<typeof realGateway.admit>[1], correlationId: string) => {
      forwarded.push(JSON.stringify(request));
      return realGateway.admit(bearer, request, correlationId);
    },
  });
  const idVerify = makeAuthVerifier({ publicKeyPem: idConfig.auth.authPublicKeyPem, issuer: idConfig.auth.jwtIssuer, audience: idConfig.auth.jwtAudience });
  const idServer = await startHttpServer({
    serviceName: 'identity-gate-selfcheck', port: 0, host: '127.0.0.1', handleSignals: false,
    routes: idGateRoutes(spyGateway, idConfig.security.nationalIdHmacKey, idVerify),
  });

  const officerToken = (sub: string, agency: Agency, roles: string[]): string => {
    const claims: AuthTokenClaims = {
      v: 1, iss: appConfig.auth.jwtIssuer, aud: appConfig.auth.jwtAudience, sub, kind: 'officer', agency, roles,
      issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    return signAuthToken(KEYS.privateKeyPem, claims);
  };
  const systemToken = signAuthToken(KEYS.privateKeyPem, {
    v: 1, iss: appConfig.auth.jwtIssuer, aud: appConfig.auth.jwtAudience, sub: 'gate-selfcheck-system', kind: 'system',
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const GATE_A = officerToken(OFFICER_A, 'RDF', ['screening_officer']);
  const GATE_B = officerToken(OFFICER_B, 'RDF', ['screening_officer']);
  const MEDIC = officerToken(OFFICER_MED, 'RDF', ['medical_officer']);
  const GATE_RNP = officerToken(OFFICER_RNP, 'RNP', ['screening_officer']);

  interface Reply { readonly status: number; readonly json: Record<string, unknown>; readonly text: string }
  const admit = async (token: string, qrToken: string, nationalId: string, gateVenueName = VENUE): Promise<Reply> => {
    const res = await fetch(`${idServer.url}/v1/gate/admissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ qrToken, nationalId, gateVenueName }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, text };
  };
  const row = async (x: Candidate) =>
    (await admin<{ status: string; physical_test_scheduled_at: Date | null }[]>`
      SELECT status::text AS status, physical_test_scheduled_at FROM ${admin(x.agency === 'RDF' ? 'rdf_ops' : 'rnp_ops')}.applications WHERE id = ${x.app}`)[0];
  const admissions = async (x: Candidate): Promise<number> =>
    (await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM rdf_ops.gate_admissions WHERE application_id = ${x.app}`)[0]?.n ?? -1;
  const attempts = async (outcome: string): Promise<number> =>
    (await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM rdf_ops.gate_admission_attempts WHERE officer_id IN ${admin(OFFICERS)} AND outcome = ${outcome}`)[0]?.n ?? -1;
  const audited = (action: string, applicationId: string, reason?: string): boolean =>
    appBus.published.some((e) => {
      const r = e as unknown as Record<string, unknown>;
      const m = (r['metadata'] ?? {}) as Record<string, unknown>;
      return r['eventType'] === 'AUDIT_ENTRY' && r['action'] === action && r['entityId'] === applicationId && (reason === undefined || m['reason'] === reason);
    });

  try {
    console.log('\n── 1. A genuine ticket and the matching card: ADMITTED, once ──');
    const first = await admit(GATE_A, tokenOf(OK), OK.nid, '  iprc   KICUKIRO stadium ');
    check('200 ADMITTED (venue typed loosely still matches)', first.status === 200 && first.json['outcome'] === 'ADMITTED', first.text);
    const cand = (first.json['candidate'] ?? {}) as Record<string, unknown>;
    check('the gate sees the candidate\'s public identifiers only', cand['processingCode'] === OK.code && cand['applicationId'] === OK.app && cand['category'] === 'GENERAL_ENLISTMENT' && Object.keys(cand).length === 3, JSON.stringify(cand));
    check('statusAdvanced = true', first.json['statusAdvanced'] === true);
    const okRow = await row(OK);
    check('SLOT_ASSIGNED → PHYSICAL_TEST_SCHEDULED, scheduled_at stamped', okRow?.status === 'PHYSICAL_TEST_SCHEDULED' && okRow.physical_test_scheduled_at !== null, JSON.stringify(okRow));
    const hist = await admin<{ performed_by: string; reason: string }[]>`
      SELECT performed_by, reason FROM rdf_ops.application_status_history
      WHERE application_id = ${OK.app} AND to_status = 'PHYSICAL_TEST_SCHEDULED'`;
    check('history row attributed to the gate officer', hist.length === 1 && hist[0]?.performed_by === OFFICER_A && hist[0]?.reason === 'Admitted at the venue gate', JSON.stringify(hist));
    const adm = await admin<{ ticket_id: string; venue_name: string; identity_method: string; admitted_by_id: string }[]>`
      SELECT ticket_id, venue_name, identity_method, admitted_by_id FROM rdf_ops.gate_admissions WHERE application_id = ${OK.app}`;
    check('one admission row: ticket, ticket venue, NATIONAL_ID_CARD, officer', adm.length === 1 && adm[0]?.ticket_id === `GA-TKT-${OK.app.slice(-4)}` && adm[0]?.venue_name === VENUE && adm[0]?.identity_method === 'NATIONAL_ID_CARD' && adm[0]?.admitted_by_id === OFFICER_A, JSON.stringify(adm));
    check('audit: APPLICANT_ADMITTED_AT_GATE + APPLICATION_STATUS_ADVANCED', audited('APPLICANT_ADMITTED_AT_GATE', OK.app) && audited('APPLICATION_STATUS_ADVANCED', OK.app));
    const staged = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public_core.event_outbox
      WHERE producer = 'application-service' AND payload->>'entityId' = ${OK.app} AND payload->>'action' = 'APPLICANT_ADMITTED_AT_GATE'`;
    check('the admission audit was staged in the outbox, in the same transaction', (staged[0]?.n ?? 0) === 1, JSON.stringify(staged));
    check('the raw national ID never left identity-service (only its hash)', forwarded.length > 0 && forwarded.every((f) => !f.includes(OK.nid)) && forwarded.some((f) => f.includes(hashNationalId(OK.nid, idConfig.security.nationalIdHmacKey))));
    check('…and is not in any response', !first.text.includes(OK.nid));

    console.log('\n── 2. Single use ──');
    const again = await admit(GATE_A, tokenOf(OK), OK.nid);
    check('same officer, same QR → 409 ALREADY_ADMITTED, admittedBySelf', again.status === 409 && again.json['error'] === 'ALREADY_ADMITTED' && again.json['admittedBySelf'] === true, again.text);
    const otherOfficer = await admit(GATE_B, tokenOf(OK), OK.nid);
    check('another officer → ALREADY_ADMITTED, not by self, with the first venue and time', otherOfficer.json['error'] === 'ALREADY_ADMITTED' && otherOfficer.json['admittedBySelf'] === false && otherOfficer.json['venueName'] === VENUE && typeof otherOfficer.json['admittedAt'] === 'string', otherOfficer.text);
    const otherGate = await admit(GATE_B, tokenOf(OK), OK.nid, 'Amahoro Stadium');
    check('a copied QR at ANOTHER gate is a duplicate, not a "wrong venue"', otherGate.json['error'] === 'ALREADY_ADMITTED', otherGate.text);
    check('still exactly one admission', (await admissions(OK)) === 1);
    check('the duplicate is audited (GATE_ADMISSION_REFUSED / ALREADY_ADMITTED)', audited('GATE_ADMISSION_REFUSED', OK.app, 'ALREADY_ADMITTED'));

    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => admit(i % 2 === 0 ? GATE_A : GATE_B, tokenOf(RACE), RACE.nid)));
    const wins = burst.filter((r) => r.status === 200).length;
    const dups = burst.filter((r) => r.json['error'] === 'ALREADY_ADMITTED').length;
    check('8 simultaneous scans of one fresh QR → exactly ONE admitted, seven duplicates', wins === 1 && dups === 7, burst.map((r) => `${String(r.status)}:${String(r.json['outcome'] ?? r.json['error'])}`).join(','));
    check('…and exactly one admission row, one status advance', (await admissions(RACE)) === 1 &&
      ((await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM rdf_ops.application_status_history WHERE application_id = ${RACE.app} AND to_status = 'PHYSICAL_TEST_SCHEDULED'`)[0]?.n ?? 0) === 1);

    console.log('\n── 3. Every refusal, and nothing admitted ──');
    const impostor = await admit(GATE_A, tokenOf(IMPOSTOR), OK.nid);
    check('someone else\'s card → 409 IDENTITY_MISMATCH', impostor.status === 409 && impostor.json['error'] === 'IDENTITY_MISMATCH', impostor.text);
    check('…not admitted, status untouched', (await admissions(IMPOSTOR)) === 0 && (await row(IMPOSTOR))?.status === 'SLOT_ASSIGNED');
    check('…audited (GATE_ADMISSION_REFUSED / IDENTITY_MISMATCH)', audited('GATE_ADMISSION_REFUSED', IMPOSTOR.app, 'IDENTITY_MISMATCH'));
    const thenRight = await admit(GATE_A, tokenOf(IMPOSTOR), IMPOSTOR.nid);
    check('the real holder with their own card is then admitted', thenRight.status === 200, thenRight.text);

    const forged = mint(OK, { venueName: VENUE }).replace(/\.[^.]+$/, '.Zm9yZ2Vk');
    const forgedRes = await admit(GATE_A, mint(RACE, {}).split('.').slice(0, 3).join('.') + '.Zm9yZ2Vk', RACE.nid);
    check('a re-signed / altered QR → 422 INVALID_TICKET TICKET_NOT_ISSUED', forgedRes.status === 422 && forgedRes.json['reason'] === 'TICKET_NOT_ISSUED', forgedRes.text);
    check('forged copy of a SPENT ticket is still not issued (forgery checked first)', (await admit(GATE_A, forged, OK.nid)).json['reason'] === 'TICKET_NOT_ISSUED');
    check('garbage → 422 MALFORMED_TICKET', (await admit(GATE_A, 'https://example.org/not-a-ticket', OK.nid)).json['reason'] === 'MALFORMED_TICKET');
    const ghost = mint({ ...OK, app: 'a9000000-0000-4000-8000-00000000dead' });
    check('a well-formed ticket for no application here → UNKNOWN_TICKET', (await admit(GATE_A, ghost, OK.nid)).json['reason'] === 'UNKNOWN_TICKET');
    check('an RNP ticket at an RDF gate → WRONG_AGENCY', (await admit(GATE_A, tokenOf(RNP), RNP.nid)).json['reason'] === 'WRONG_AGENCY');

    const wrongGate = await admit(GATE_A, tokenOf(SCHEDULED), SCHEDULED.nid, 'Amahoro Stadium');
    check('wrong gate → 409 WRONG_VENUE naming the ticket\'s venue', wrongGate.json['error'] === 'WRONG_VENUE' && wrongGate.json['ticketVenueName'] === VENUE, wrongGate.text);
    const early = await admit(GATE_A, tokenOf(EARLY), EARLY.nid);
    check('tomorrow\'s ticket → 409 TOO_EARLY', early.json['error'] === 'TOO_EARLY' && early.json['examDate'] === examDateFor(1), early.text);
    const late = await admit(GATE_A, tokenOf(LATE), LATE.nid);
    check('yesterday\'s ticket → 409 EXPIRED', late.json['error'] === 'EXPIRED', late.text);
    const gone = await admit(GATE_A, tokenOf(WITHDRAWN), WITHDRAWN.nid);
    check('a withdrawn candidate → 409 NOT_ADMISSIBLE (WITHDRAWN)', gone.json['error'] === 'NOT_ADMISSIBLE' && gone.json['currentStatus'] === 'WITHDRAWN', gone.text);
    check('none of them admitted', (await admissions(EARLY)) + (await admissions(LATE)) + (await admissions(WITHDRAWN)) === 0);
    check('a malformed card number is refused at identity-service (400)', (await admit(GATE_A, tokenOf(SCHEDULED), '123')).status === 400);

    const sched = await admit(GATE_A, tokenOf(SCHEDULED), SCHEDULED.nid);
    check('already PHYSICAL_TEST_SCHEDULED: admitted, statusAdvanced = false, no second history row', sched.status === 200 && sched.json['statusAdvanced'] === false &&
      ((await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM rdf_ops.application_status_history WHERE application_id = ${SCHEDULED.app}`)[0]?.n ?? -1) === 0, sched.text);

    console.log('\n── 4. Who may admit ──');
    const before = forwarded.length;
    check('a medical officer → 403 at identity-service', (await admit(MEDIC, tokenOf(EARLY), EARLY.nid)).status === 403);
    check('…and nothing was forwarded', forwarded.length === before);
    const direct = await fetch(`${appServer.url}/v1/applications/admissions/gate`, {
      method: 'POST', headers: { authorization: `Bearer ${MEDIC}`, 'content-type': 'application/json' },
      body: JSON.stringify({ qrToken: tokenOf(EARLY), gateVenueName: VENUE, nationalIdHash: 'a'.repeat(64) }),
    });
    check('application-service enforces it too (403 PERMISSION_DENIED), not just the front door', direct.status === 403);
    const sys = await fetch(`${appServer.url}/v1/applications/admissions/gate`, {
      method: 'POST', headers: { authorization: `Bearer ${systemToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ qrToken: tokenOf(EARLY), gateVenueName: VENUE, nationalIdHash: 'a'.repeat(64) }),
    });
    check('a system token cannot admit anyone (403)', sys.status === 403);
    const rnpAtRnp = await admit(GATE_RNP, tokenOf(RNP), RNP.nid);
    check('the RNP gate admits its own candidate', rnpAtRnp.status === 200, rnpAtRnp.text);
    check('an RNP officer presented an RDF ticket → WRONG_AGENCY', (await admit(GATE_RNP, tokenOf(EARLY), EARLY.nid)).json['reason'] === 'WRONG_AGENCY');

    console.log('\n── 5. The citizen\'s QR page after admission ──');
    const inv = await fetch(`${appServer.url}/v1/applications/exam-invitation/by-applicant?applicantId=${OK.applicant}&applicationId=${OK.app}`, {
      headers: { authorization: `Bearer ${systemToken}` },
    });
    const invText = await inv.text();
    const invJson = JSON.parse(invText) as Record<string, unknown>;
    check('state ADMITTED with where and when', invJson['state'] === 'ADMITTED' && (invJson['admission'] as Record<string, unknown> | undefined)?.['venueName'] === VENUE, invText);
    check('the spent QR is never handed back', !invText.includes('qrPayload') && !invText.includes('USRP-SLOT'));

    console.log('\n── 6. The log of every scan ──');
    check('attempts logged per outcome', (await attempts('ADMITTED')) === 4 && (await attempts('ALREADY_ADMITTED')) === 10 &&
      (await attempts('IDENTITY_MISMATCH')) === 1 && (await attempts('TICKET_NOT_ISSUED')) === 2 && (await attempts('MALFORMED_TICKET')) === 1 &&
      (await attempts('UNKNOWN_TICKET')) === 1 && (await attempts('WRONG_AGENCY')) === 1 && (await attempts('WRONG_VENUE')) === 1 &&
      (await attempts('TOO_EARLY')) === 1 && (await attempts('EXPIRED')) === 1 && (await attempts('NOT_ADMISSIBLE')) === 1,
      JSON.stringify(await admin`SELECT outcome, count(*)::int AS n FROM rdf_ops.gate_admission_attempts WHERE officer_id IN ${admin(OFFICERS)} GROUP BY outcome ORDER BY outcome`));
    check('the RNP officer\'s scans are logged in RNP\'s own schema', ((await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM rnp_ops.gate_admission_attempts WHERE officer_id = ${OFFICER_RNP}`)[0]?.n ?? 0) === 2);

    console.log('\n── 7. Append-only and agency-isolated, in the engine ──');
    const refused = async (q: Promise<unknown>): Promise<string> => {
      try { await q; return 'ALLOWED'; } catch (e) { return (e as { code?: string }).code ?? 'ERR'; }
    };
    check('even the owner cannot UPDATE an admission (trigger)', (await refused(admin`UPDATE rdf_ops.gate_admissions SET venue_name = 'x' WHERE application_id = ${OK.app}`)) === '42501');
    check('…nor DELETE it', (await refused(admin`DELETE FROM rdf_ops.gate_admissions WHERE application_id = ${OK.app}`)) === '42501');
    check('…nor rewrite the attempts log', (await refused(admin`UPDATE rdf_ops.gate_admission_attempts SET outcome = 'ADMITTED' WHERE officer_id = ${OFFICER_A}`)) === '42501');
    const asRole = (role: string, q: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<string> =>
      refused(admin.begin(async (tx) => { await tx`SET LOCAL ROLE ${tx(role)}`; await q(tx); }));
    check('the RDF officer role cannot UPDATE its own admissions', (await asRole('usrp_rdf_officer', (tx) => tx`UPDATE rdf_ops.gate_admissions SET venue_name = 'x'`)) === '42501');
    check('the RNP officer role cannot read RDF admissions', (await asRole('usrp_rnp_officer', (tx) => tx`SELECT 1 FROM rdf_ops.gate_admissions LIMIT 1`)) === '42501');
    check('the RNP officer role cannot ask the RDF identity-match function', (await asRole('usrp_rnp_officer', (tx) => tx`SELECT rdf_ops.gate_identity_matches(${OK.app}::uuid, ${'a'.repeat(64)})`)) === '42501');
    const visible = await admin.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      return tx<{ id: string }[]>`SELECT id FROM public_core.applicant_identities WHERE id = ${RNP.applicant}`;
    });
    check('an RDF officer cannot see the identity of a candidate with no RDF application', visible.length === 0);
    const matchTrue = await admin.begin(async (tx) => { await tx`SET LOCAL ROLE usrp_rdf_officer`; return tx<{ m: boolean }[]>`SELECT rdf_ops.gate_identity_matches(${OK.app}::uuid, ${hashNationalId(OK.nid, idConfig.security.nationalIdHmacKey)}) AS m`; });
    check('the match function answers a boolean, and only that', matchTrue[0]?.m === true && Object.keys(matchTrue[0] ?? {}).length === 1);
  } finally {
    await idServer.stop();
    await appServer.stop();
    await cleanup();
    await admin.end();
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures > 0) {
    console.error(`GATE ADMISSION — ${String(failures)} check(s) failed ✗`);
    process.exit(1);
  }
  console.log('GATE ADMISSION PROVEN — single-use, identity-bound, agency-isolated, append-only ✓');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
