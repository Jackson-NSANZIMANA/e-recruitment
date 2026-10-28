// ══════════════════════════════════════════════════════════════════
// USRP Rehearsal — CLI
//
//   pnpm rehearse                      stage national-pilot-day for today
//   pnpm rehearse <scenario-id>        stage another scenario
//   pnpm rehearse --status             list today's open rehearsal campaigns
//   pnpm rehearse --roster [--expect-code CODE]   assert the Gasabo venue roster is minimal (ADR-039)
//
// Requires the platform running (`pnpm dev`). Dev and training only: refuses
// NODE_ENV=production and any non-local database or edge (see fence.ts).
// Writes the stage manifest to <repo>/.rehearsal/last-run.json for the E2E
// harness and prints it for people.
// ══════════════════════════════════════════════════════════════════

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agency } from '@usrp/shared-types';
import { conduct, type AdminCredential, type RehearsalReport } from './conductor.js';
import { EdgeSession, EdgeUnavailable } from './edge.js';
import { RehearsalRefused, assertRehearsalAllowed } from './fence.js';
import { isRehearsalCode, rehearsalCode, ScenarioInvalid, validateScenario, type Scenario } from './scenario.js';
import { assertGasaboRoster, RosterAssertion } from './roster.js';
import { REHEARSAL_STAFF_PASSWORD, provisionStaff } from './staff.js';
import { recordShadowEvidence } from './biometric.js';
import { FleetAssertion, rehearseFleet } from './fleet.js';
import { completePhysicalTest } from './physical.js';
import { ensureAgencyAdmin, ensureSecondAgencyAdmin } from './provision.js';
import { runJourney, type JourneySubject } from './journey.js';
import { kigaliReferenceDate, loadPrivatePersona, Population } from '@usrp/g2g-sandbox';
import { parseDateOfBirth } from '@usrp/shared-identity-match';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

/** Same local default as scripts/bootstrap-db.sh; the fence rejects anything non-local. */
const DEFAULT_DATABASE_URL = 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const SANDBOX_EDGE_URL = 'http://localhost:4921';
const SANDBOX_ORIGIN = 'http://localhost:4930';
const SANDBOX_DATABASE_URL = 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_sandbox';
/** DEV-ONLY, documented like seed-dev-officers' DevOfficer#2026. */
const DEFAULT_ADMIN_PASSWORD = 'RehearsalAdmin#2026';
const DEV_OFFICER_PASSWORD = 'DevOfficer#2026';

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function adminFor(agency: Agency): AdminCredential {
  return {
    loginHandle: env(`REHEARSAL_${agency}_ADMIN_HANDLE`) ?? `${agency.toLowerCase()}.admin`,
    password: env(`REHEARSAL_${agency}_ADMIN_PASSWORD`) ?? DEFAULT_ADMIN_PASSWORD,
  };
}

function secondAdminFor(agency: Agency): AdminCredential {
  return {
    loginHandle: env(`REHEARSAL_${agency}_ADMIN2_HANDLE`) ?? `${agency.toLowerCase()}.admin2`,
    password: env(`REHEARSAL_${agency}_ADMIN2_PASSWORD`) ?? DEFAULT_ADMIN_PASSWORD,
  };
}

function loadScenario(id: string): Scenario {
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(id)) throw new ScenarioInvalid(`"${id}" is not a scenario id.`);
  const file = join(PACKAGE_ROOT, 'scenarios', `${id}.json`);
  let scenario: Scenario;
  try {
    scenario = JSON.parse(readFileSync(file, 'utf8')) as Scenario;
  } catch {
    throw new ScenarioInvalid(`No readable scenario at ${file}.`);
  }
  validateScenario(scenario);
  return scenario;
}

const MARK: Readonly<Record<string, string>> = { APPLIED: '✓', REPLAYED: '↺', ALREADY_DONE: '=', FAILED: '✗' };

function printReport(report: RehearsalReport, scenario: Scenario, edgeBaseUrl: string): void {
  out();
  out(`USRP REHEARSAL · ${report.title} (${report.scenarioId} v${String(report.scenarioVersion)}) · Kigali date ${report.kigaliDate}`);
  out('Synthetic campaigns. Legal basis SYNTHETIC-REHEARSAL. Not a Government of Rwanda recruitment.');
  out();
  for (const c of report.campaigns) {
    out(`${c.agency}  ${c.publicCode}  ${c.label}  ${c.publiclyVisible ? '— published, visible to citizens' : '— NOT published'}`);
    out(`     sessions: ${c.sessions.map((s) => `${s.venueName} ${s.examDate} ${String(s.reportingHour).padStart(2, '0')}:00`).join(' · ')}`);
    out(`     steps:    ${c.steps.map((s) => `${MARK[s.outcome] ?? '?'} ${s.step}`).join('  ')}`);
    for (const failed of c.steps.filter((s) => s.outcome === 'FAILED')) {
      out(`     ✗ ${failed.step}: ${failed.detail}${failed.httpStatus === null ? '' : ` (HTTP ${String(failed.httpStatus)})`}`);
    }
  }
  out();
  out('Sign in');
  out('  Applicant portal   http://localhost:3000/login     (codes: pnpm dev:sms)');
  out('  Officer console    http://localhost:3001');
  for (const c of report.campaigns) {
    const agency = c.agency.toLowerCase();
    out(`    ${c.agency}: ${agency}.officer / ${DEV_OFFICER_PASSWORD} (gate, walk-in, medical)  ·  ${agency}.director / ${DEV_OFFICER_PASSWORD} (decide, accept)  ·  ${c.adminHandle} (campaigns, staff)`);
    if (c.staffHandles.length > 0) out(`      staff (password ${REHEARSAL_STAFF_PASSWORD}): ${c.staffHandles.join(', ')}`);
  }
  out();
  out('Personas');
  for (const p of scenario.personas) {
    out(
      p.sandboxPersona !== undefined
        ? `  ${p.id}  ${p.role}: sandbox persona ${p.sandboxPersona} (facts served by the g2g-sandbox simulators)`
        : `  ${p.id}  ${p.role}: NID ${p.nationalId ?? '?'} · born ${p.dateOfBirth ?? '?'} · phone ${p.phone ?? '?'} · ${p.homeDistrict ?? '?'}`,
    );
    out(`     rehearses: ${p.rehearses}`);
    out(`     expected:  ${p.expectedOutcome}`);
  }
  out();
  out(`Edge ${edgeBaseUrl} · manifest .rehearsal/last-run.json · legend ✓ applied  ↺ replayed  = already done  ✗ failed`);
  out(report.ok ? 'REHEARSAL STAGED.' : 'REHEARSAL INCOMPLETE — see ✗ above.');
}

async function status(edgeBaseUrl: string, origin: string): Promise<number> {
  const edge = new EdgeSession(edgeBaseUrl, origin);
  const list = await edge.get('/edge/v1/campaigns');
  const campaigns = (list.body as { campaigns?: { publicCode?: string; campaignLabel?: string; agency?: string }[] } | null)?.campaigns ?? [];
  const rehearsals = campaigns.filter((c) => typeof c.publicCode === 'string' && isRehearsalCode(c.publicCode));
  out(rehearsals.length === 0 ? 'No open rehearsal campaigns. Run `pnpm rehearse`.' : 'Open rehearsal campaigns:');
  for (const c of rehearsals) out(`  ${c.agency ?? '?'}  ${c.publicCode ?? '?'}  ${c.campaignLabel ?? ''}`);
  return 0;
}

/** ADR-039: the Gasabo gate officer reads today's roster and it must be minimal. */
async function roster(edgeBaseUrl: string, origin: string, expectCode: string | null): Promise<number> {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.rehearsal', 'last-run.json'), 'utf8')) as RehearsalReport;
  const rdf = manifest.campaigns.find((c) => c.agency === 'RDF');
  const session = rdf?.sessions.find((s) => s.district === 'GASABO');
  const handle = rdf?.staffHandles.find((h) => h.endsWith('.gate.gasabo'));
  if (rdf === undefined || session === undefined || handle === undefined) throw new ScenarioInvalid('The last run has no RDF Gasabo session or gate officer; run `pnpm rehearse` first.');
  const edge = new EdgeSession(edgeBaseUrl, origin);
  if (!(await edge.signIn(handle, REHEARSAL_STAFF_PASSWORD))) throw new ScenarioInvalid(`The edge refused ${handle}.`);
  const query = new URLSearchParams({ campaign: rdf.publicCode, district: session.district, examDate: session.examDate });
  const response = await edge.get(`/edge/v1/gate/roster?${query.toString()}`);
  if (response.status !== 200) throw new RosterAssertion(`roster read answered HTTP ${String(response.status)}`);
  const count = assertGasaboRoster(response.body, expectCode);
  out(`ROSTER OK · ${session.venueName} ${session.examDate} · ${String(count)} candidate(s), no names or National IDs${expectCode === null ? '' : `, contains ${expectCode}`}.`);
  return 0;
}

/**
 * ADR-037, dev-only: record one signed SYNTHETIC SHADOW evidence record for a
 * persona of the scenario's SHADOW agency, then prove it invisible to
 * officers and stored. Staffs the agency first (idempotent), like `rehearse`.
 */
async function biometricShadow(
  argv: readonly string[],
  where: { readonly edgeBaseUrl: string; readonly origin: string; readonly databaseUrl: string },
): Promise<number> {
  const scenario = loadScenario('national-pilot-day');
  const personaId = argv[argv.indexOf('--biometric-shadow') + 1] ?? 'A';
  const persona = scenario.personas.find((p) => p.id === personaId) ?? scenario.personas.find((p) => p.id === 'A');
  const campaign = scenario.campaigns.find((c) => c.biometricMode === 'SHADOW');
  if (persona === undefined || campaign === undefined) throw new ScenarioInvalid('No SHADOW agency or persona in the scenario.');
  const agency = campaign.agency as Agency;
  const admin = adminFor(agency);
  const provisioned = await ensureAgencyAdmin(where.databaseUrl, {
    agency, loginHandle: admin.loginHandle, password: admin.password,
    operatorReference: 'REHEARSAL-BIOMETRIC-SHADOW', correlationId: `REH-BIO-${agency}-ADMIN`,
  });
  if (provisioned.kind === 'OTHER_ADMIN') throw new RehearsalRefused(`${agency} already has another administrator.`);
  const edge = new EdgeSession(where.edgeBaseUrl, where.origin);
  if (!(await edge.signIn(admin.loginHandle, admin.password))) throw new RehearsalRefused(`edge refused ${admin.loginHandle}`);
  const staff = campaign.staff ?? [];
  const second = secondAdminFor(agency);
  await ensureSecondAgencyAdmin(where.databaseUrl, { agency, loginHandle: second.loginHandle, password: second.password });
  const releaser = new EdgeSession(where.edgeBaseUrl, where.origin);
  if (!(await releaser.signIn(second.loginHandle, second.password))) throw new RehearsalRefused(`edge refused ${second.loginHandle}`);
  const staffed = await provisionStaff(edge, releaser, () => new EdgeSession(where.edgeBaseUrl, where.origin), staff);
  const gate = staff.find((m) => m.posts.includes('screening_officer'));
  const reader = staff.find((m) => m.posts.includes('field_supervisor') || m.posts.includes('reviewer'));
  if (staffed.some((m) => !m.ok) || gate === undefined || reader === undefined) {
    out('biometric shadow: staffing failed or the scenario lacks a gate officer and a reader');
    return 1;
  }
  const steps = await recordShadowEvidence({
    edgeBaseUrl: where.edgeBaseUrl, origin: where.origin, databaseUrl: where.databaseUrl, agency,
    nationalId: persona.nationalId ?? '',
    gateOfficer: { loginHandle: gate.handle, password: REHEARSAL_STAFF_PASSWORD },
    reader: { loginHandle: reader.handle, password: REHEARSAL_STAFF_PASSWORD },
    now: new Date(),
  });
  out(`USRP REHEARSAL · biometric SHADOW evidence · ${agency} · persona ${persona.id} (synthetic record; no face is captured)`);
  for (const s of steps) out(`  ${s.ok ? '✓' : '✗'} ${s.step}: ${s.detail}`);
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  out(ok ? 'SHADOW EVIDENCE RECORDED AND INVISIBLE TO OFFICERS.' : 'BIOMETRIC SHADOW REHEARSAL INCOMPLETE — see ✗ above.');
  return ok ? 0 : 1;
}

/** S09: device fleet lifecycle and the Gasabo venue's live counts, on the real stack. */
async function fleet(where: { readonly edgeBaseUrl: string; readonly origin: string; readonly databaseUrl: string }): Promise<number> {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.rehearsal', 'last-run.json'), 'utf8')) as RehearsalReport;
  const rdf = manifest.campaigns.find((c) => c.agency === 'RDF');
  const session = rdf?.sessions.find((s) => s.district === 'GASABO');
  const gate = rdf?.staffHandles.find((h) => h.endsWith('.gate.gasabo'));
  const supervisor = rdf?.staffHandles.find((h) => h.endsWith('.supervisor'));
  if (rdf === undefined || session === undefined || gate === undefined || supervisor === undefined) {
    throw new ScenarioInvalid('The last run has no RDF Gasabo session, gate officer and supervisor; run `pnpm rehearse` first.');
  }
  const steps = await rehearseFleet({
    ...where, agency: 'RDF', campaignCode: rdf.publicCode, district: session.district, examDate: session.examDate,
    gate: { loginHandle: gate, password: REHEARSAL_STAFF_PASSWORD }, supervisor: { loginHandle: supervisor, password: REHEARSAL_STAFF_PASSWORD }, now: new Date(),
  });
  out(`USRP REHEARSAL · device fleet and venue live counts · ${session.venueName} ${session.examDate}`);
  for (const s of steps) out(`  ${s.ok ? '✓' : '✗'} ${s.step}: ${s.detail}`);
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  out(ok ? 'FLEET REHEARSAL PASSED.' : 'FLEET REHEARSAL FAILED — see ✗ above.');
  return ok ? 0 : 1;
}

/** S06, dev-only: sync one synthetic score so an admitted application reaches PHYSICAL_TEST_COMPLETE. */
async function completePhysical(argv: readonly string[], where: { readonly edgeBaseUrl: string; readonly origin: string; readonly databaseUrl: string }): Promise<number> {
  const at = argv.indexOf('--complete-physical');
  const applicationId = argv[at + 1] ?? '';
  const qrInvitationCode = argv[at + 2] ?? null;
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, '.rehearsal', 'last-run.json'), 'utf8')) as RehearsalReport;
  const rdf = manifest.campaigns.find((c) => c.agency === 'RDF');
  const gate = rdf?.staffHandles.find((h) => h.endsWith('.gate.gasabo'));
  if (gate === undefined) throw new ScenarioInvalid('The last run has no RDF Gasabo gate officer; run `pnpm rehearse` first.');
  const steps = await completePhysicalTest({ ...where, agency: 'RDF', gate: { loginHandle: gate, password: REHEARSAL_STAFF_PASSWORD }, applicationId, qrInvitationCode, now: new Date() });
  out('USRP REHEARSAL · complete the physical test (synthetic score)');
  for (const s of steps) out(`  ${s.ok ? '✓' : '✗'} ${s.step}: ${s.detail}`);
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  out(ok ? 'PHYSICAL TEST COMPLETED.' : 'COMPLETE-PHYSICAL FAILED — see ✗ above.');
  return ok ? 0 : 1;
}

/**
 * S12a: the sandbox journey for every catalogue persona of a staged scenario
 * (`pnpm rehearse <id>` first). `--private` adds the owner's private persona
 * (SANDBOX_PRIVATE_PERSONA_DIR, read in memory, reported as PRIVATE with
 * pass/fail only).
 */
async function journey(argv: readonly string[], where: { readonly edgeBaseUrl: string; readonly origin: string }): Promise<number> {
  const scenarioId = argv.find((arg) => !arg.startsWith('--')) ?? 'rnp-basic-2025';
  const scenario = loadScenario(scenarioId);
  const campaign = scenario.campaigns[0];
  if (campaign === undefined) throw new ScenarioInvalid('The scenario has no campaign.');
  if (!scenario.personas.some((p) => p.sandboxPersona !== undefined)) {
    out(`${scenarioId}: no catalogue personas to drive (staged only).`);
    return 0;
  }
  const gate = campaign.staff?.find((m) => m.posts.includes('screening_officer'));
  const reader = campaign.staff?.find((m) => m.posts.includes('reviewer') || m.posts.includes('field_supervisor'));
  if (gate === undefined || reader === undefined) throw new ScenarioInvalid('The journey needs a screening officer and a reviewer in the scenario staff.');
  const now = new Date();
  const population = new Population({ seed: 1, size: 0, referenceDate: kigaliReferenceDate(now) });
  const subjects: JourneySubject[] = [];
  for (const p of scenario.personas) {
    if (p.sandboxPersona === undefined || p.expect === undefined || p.category === undefined) continue;
    const c = population.persona(p.sandboxPersona);
    subjects.push({ label: `${p.id}/${p.sandboxPersona}`, nationalId: c.nid, dateOfBirth: c.dateOfBirth, phone: c.phone, nesaIndexNumber: c.nesa?.studentIndexNumber ?? null, category: p.category, expect: p.expect });
  }
  if (argv.includes('--private')) {
    const persona = loadPrivatePersona(process.env['SANDBOX_PRIVATE_PERSONA_DIR']);
    if (persona === null) throw new ScenarioInvalid('--private needs SANDBOX_PRIVATE_PERSONA_DIR.');
    const dobRaw = persona.identityInfo['dateOfBirth'];
    const dob = typeof dobRaw === 'string' ? parseDateOfBirth(dobRaw) : null;
    const index = typeof persona.nesa?.['studentIndexNumber'] === 'string' ? persona.nesa['studentIndexNumber'] : (env('SANDBOX_NESA_LIVE_INDEX') ?? null);
    if (dob === null) throw new ScenarioInvalid('The private persona has no readable date of birth.');
    const at = argv.indexOf('--private-category');
    subjects.push({ label: 'PRIVATE', nationalId: persona.nid, dateOfBirth: dob, phone: '0788009999', nesaIndexNumber: index, category: at >= 0 ? (argv[at + 1] ?? campaign.categories[0] ?? '') : (campaign.categories[0] ?? ''), expect: { outcome: 'BOUND' } });
  }
  const config = {
    ...where,
    smsInbox: env('REHEARSAL_SMS_INBOX') ?? join(REPO_ROOT, '.sandbox', 'sms', 'inbox.jsonl'),
    campaignCode: rehearsalCode(campaign.agency as Agency, now, campaign.codeTag),
    gateOfficer: { loginHandle: gate.handle, password: REHEARSAL_STAFF_PASSWORD },
    reader: { loginHandle: reader.handle, password: REHEARSAL_STAFF_PASSWORD },
  };
  out(`USRP SANDBOX JOURNEY · ${scenario.title} · ${config.campaignCode}`);
  let ok = true;
  for (const subject of subjects) {
    const steps = await runJourney(subject, config);
    const passed = steps.length > 0 && steps.every((s) => s.ok);
    ok &&= passed;
    out(`${passed ? '✓' : '✗'} ${subject.label} → expected ${subject.expect.outcome}${'gate' in subject.expect ? ` (${subject.expect.gate})` : ''}${'failureCode' in subject.expect ? ` (${subject.expect.failureCode})` : ''}`);
    // The private run reports pass/fail only, never step details.
    if (subject.label !== 'PRIVATE') for (const s of steps) out(`    ${s.ok ? '✓' : '✗'} ${s.step}${s.detail === '' ? '' : `: ${s.detail}`}`);
  }
  out(ok ? 'SANDBOX JOURNEY PASSED.' : 'SANDBOX JOURNEY FAILED — see ✗ above.');
  return ok ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  // --sandbox targets a running `pnpm sandbox` (edge :4921, its own usrp_sandbox database) instead of `pnpm dev`.
  const sandbox = argv.includes('--sandbox');
  const edgeBaseUrl = env('REHEARSAL_EDGE_URL') ?? (sandbox ? SANDBOX_EDGE_URL : `http://localhost:${env('PORT_EDGE_GATEWAY') ?? '4021'}`);
  const origin = env('REHEARSAL_ORIGIN') ?? (sandbox ? SANDBOX_ORIGIN : 'http://localhost:3001');
  const databaseUrl = env('REHEARSAL_DATABASE_URL') ?? (sandbox ? SANDBOX_DATABASE_URL : env('DEV_SEED_DATABASE_URL') ?? DEFAULT_DATABASE_URL);
  assertRehearsalAllowed({ nodeEnv: process.env['NODE_ENV'], databaseUrl, edgeBaseUrl });

  if (argv.includes('--status')) return status(edgeBaseUrl, origin);
  if (argv.includes('--roster')) {
    const at = argv.indexOf('--expect-code');
    return roster(edgeBaseUrl, origin, at >= 0 ? (argv[at + 1] ?? null) : null);
  }
  if (argv.includes('--fleet')) return fleet({ edgeBaseUrl, origin, databaseUrl });
  if (argv.includes('--complete-physical')) return completePhysical(argv, { edgeBaseUrl, origin, databaseUrl });
  if (argv.includes('--journey')) return journey(argv, { edgeBaseUrl, origin });
  if (argv.includes('--biometric-shadow')) {
    return biometricShadow(argv, { edgeBaseUrl, origin, databaseUrl });
  }
  const scenarioId = argv.find((arg) => !arg.startsWith('--')) ?? 'national-pilot-day';
  const scenario = loadScenario(scenarioId);

  const report = await conduct(scenario, { edgeBaseUrl, origin, databaseUrl, now: new Date(), adminFor, secondAdminFor });
  const manifestDir = join(REPO_ROOT, '.rehearsal');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, 'last-run.json'), `${JSON.stringify({ ...report, personas: scenario.personas }, null, 2)}\n`);
  printReport(report, scenario, edgeBaseUrl);
  return report.ok ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const known = error instanceof RehearsalRefused || error instanceof ScenarioInvalid || error instanceof EdgeUnavailable || error instanceof RosterAssertion || error instanceof FleetAssertion;
    process.stderr.write(`rehearsal: ${known ? (error as Error).message : `unexpected failure: ${error instanceof Error ? error.message : String(error)}`}\n`);
    process.exitCode = known ? 2 : 1;
  });
