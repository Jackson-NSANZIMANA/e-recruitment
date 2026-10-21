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
import { isRehearsalCode, ScenarioInvalid, validateScenario, type Scenario } from './scenario.js';
import { assertGasaboRoster, RosterAssertion } from './roster.js';
import { REHEARSAL_STAFF_PASSWORD, provisionStaff } from './staff.js';
import { recordShadowEvidence } from './biometric.js';
import { FleetAssertion, rehearseFleet } from './fleet.js';
import { ensureAgencyAdmin, ensureSecondAgencyAdmin } from './provision.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

/** Same local default as scripts/bootstrap-db.sh; the fence rejects anything non-local. */
const DEFAULT_DATABASE_URL = 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
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
    out(`  ${p.id}  ${p.role}: NID ${p.nationalId} · born ${p.dateOfBirth} · phone ${p.phone} · ${p.homeDistrict}`);
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
    nationalId: persona.nationalId,
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

async function main(argv: readonly string[]): Promise<number> {
  const edgeBaseUrl = env('REHEARSAL_EDGE_URL') ?? `http://localhost:${env('PORT_EDGE_GATEWAY') ?? '4021'}`;
  const origin = env('REHEARSAL_ORIGIN') ?? 'http://localhost:3001';
  const databaseUrl = env('REHEARSAL_DATABASE_URL') ?? env('DEV_SEED_DATABASE_URL') ?? DEFAULT_DATABASE_URL;
  assertRehearsalAllowed({ nodeEnv: process.env['NODE_ENV'], databaseUrl, edgeBaseUrl });

  if (argv.includes('--status')) return status(edgeBaseUrl, origin);
  if (argv.includes('--roster')) {
    const at = argv.indexOf('--expect-code');
    return roster(edgeBaseUrl, origin, at >= 0 ? (argv[at + 1] ?? null) : null);
  }
  if (argv.includes('--fleet')) return fleet({ edgeBaseUrl, origin, databaseUrl });
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
