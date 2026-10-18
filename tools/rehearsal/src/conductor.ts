// ══════════════════════════════════════════════════════════════════
// rehearsal — the conductor
//
// Plays a scenario against the running platform through its real
// interfaces only: first-admin provisioning, then draft → immutable policy
// → district sessions → publish over /edge/v1/**, with deterministic
// Idempotency-Keys so a re-run on the same day replays instead of duplicating.
// Yesterday's rehearsal campaigns are closed through the same API, never
// deleted. Every step reports what actually happened; nothing is assumed.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';
import { kigaliDate } from './clock.js';
import { EdgeSession } from './edge.js';
import { deterministicKey } from './idempotency.js';
import { syntheticPolicy } from './policy.js';
import { ensureAgencyAdmin } from './provision.js';
import { REHEARSAL_CODE_PREFIX, stageCampaigns, type Scenario, type StagedCampaign } from './scenario.js';

export type StepOutcome = 'APPLIED' | 'REPLAYED' | 'ALREADY_DONE' | 'FAILED';

export interface StepReport {
  readonly step: string;
  readonly outcome: StepOutcome;
  readonly httpStatus: number | null;
  readonly detail: string;
}

export interface CampaignReport {
  readonly agency: Agency;
  readonly publicCode: string;
  readonly label: string;
  readonly adminHandle: string;
  readonly publiclyVisible: boolean;
  readonly sessions: readonly { readonly district: string; readonly venueName: string; readonly examDate: string; readonly reportingHour: number }[];
  readonly steps: readonly StepReport[];
}

export interface RehearsalReport {
  readonly scenarioId: string;
  readonly scenarioVersion: number;
  readonly title: string;
  readonly kigaliDate: string;
  readonly ok: boolean;
  readonly campaigns: readonly CampaignReport[];
}

export interface AdminCredential {
  readonly loginHandle: string;
  readonly password: string;
}

export interface ConductorConfig {
  readonly edgeBaseUrl: string;
  readonly origin: string;
  readonly databaseUrl: string;
  readonly now: Date;
  readonly adminFor: (agency: Agency) => AdminCredential;
}

function codeOf(body: unknown): string {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['error', 'status', 'outcome']) {
      const value = record[key];
      if (typeof value === 'string') return value;
    }
  }
  return '';
}

/** PURE. What one control-plane command response means for the rehearsal. */
export function classify(step: string, status: number, replayed: boolean, body: unknown): StepReport {
  const code = codeOf(body);
  if (status >= 200 && status < 300) {
    return { step, outcome: replayed ? 'REPLAYED' : 'APPLIED', httpStatus: status, detail: replayed ? 'idempotent replay of the original command' : code || 'ok' };
  }
  return { step, outcome: 'FAILED', httpStatus: status, detail: code || 'no detail' };
}

async function playCampaign(scenario: Scenario, staged: StagedCampaign, config: ConductorConfig): Promise<CampaignReport> {
  const { agency, draft } = staged;
  const admin = config.adminFor(agency);
  const steps: StepReport[] = [];
  const report = (publiclyVisible: boolean): CampaignReport => ({
    agency,
    publicCode: draft.publicCode,
    label: draft.campaignLabel,
    adminHandle: admin.loginHandle,
    publiclyVisible,
    sessions: staged.sessions.map((s) => ({ district: s.district, venueName: s.venueName, examDate: s.examDate, reportingHour: s.reportingTimeHour })),
    steps,
  });

  // 1. The agency administrator, through the first-admin function.
  const outcome = await ensureAgencyAdmin(config.databaseUrl, {
    agency,
    loginHandle: admin.loginHandle,
    password: admin.password,
    operatorReference: `REHEARSAL-${scenario.id.toUpperCase()}`,
    correlationId: `${draft.publicCode}-ADMIN`,
  });
  if (outcome.kind === 'OTHER_ADMIN') {
    steps.push({
      step: 'administrator',
      outcome: 'FAILED',
      httpStatus: null,
      detail: `${agency} already has an administrator (${outcome.existingHandles.join(', ')}); set REHEARSAL_${agency}_ADMIN_HANDLE and REHEARSAL_${agency}_ADMIN_PASSWORD to rehearse as them.`,
    });
    return report(false);
  }
  steps.push({ step: 'administrator', outcome: outcome.kind === 'PROVISIONED' ? 'APPLIED' : 'ALREADY_DONE', httpStatus: null, detail: outcome.loginHandle });

  // 2. Sign in at the edge, as the console would.
  const edge = new EdgeSession(config.edgeBaseUrl, config.origin);
  if (!(await edge.signIn(admin.loginHandle, admin.password))) {
    steps.push({ step: 'sign-in', outcome: 'FAILED', httpStatus: null, detail: `edge refused ${admin.loginHandle}; is the password the one this administrator was provisioned with?` });
    return report(false);
  }
  steps.push({ step: 'sign-in', outcome: 'APPLIED', httpStatus: 200, detail: admin.loginHandle });

  // 3. Retire earlier days' rehearsal campaigns for this agency (close, never delete).
  const open = await edge.get('/edge/v1/campaigns');
  const openCodes = Array.isArray((open.body as { campaigns?: unknown } | null)?.campaigns)
    ? ((open.body as { campaigns: { publicCode?: unknown }[] }).campaigns.map((c) => c.publicCode).filter((c): c is string => typeof c === 'string'))
    : [];
  for (const code of openCodes) {
    if (!code.startsWith(`${REHEARSAL_CODE_PREFIX}${agency}-`) || code === draft.publicCode) continue;
    const closed = await edge.post('/edge/v1/campaigns/registration-close', { publicCode: code }, deterministicKey(scenario.id, code, 'retire'));
    steps.push(classify(`retire ${code}`, closed.status, closed.replayed, closed.body));
  }

  // A published campaign's structure is frozen (BUILD-001): if today's code is
  // already visible to citizens there is nothing left to apply, whoever or
  // whatever version staged it. Verified from the public side, not assumed.
  const existing = await edge.get(`/edge/v1/campaigns/detail?publicCode=${encodeURIComponent(draft.publicCode)}`);
  if (existing.status === 200) {
    steps.push({ step: 'published', outcome: 'ALREADY_DONE', httpStatus: 200, detail: 'already published and visible to citizens; structure is frozen' });
    return report(true);
  }

  // 4–7. Draft → policy → sessions → publish, each idempotent.
  const key =(...parts: string[]): string => deterministicKey(scenario.id, String(scenario.version), draft.publicCode, ...parts);
  const created = await edge.post('/edge/v1/campaigns', draft, key('draft'));
  steps.push(classify('draft', created.status, created.replayed, created.body));
  if (steps.at(-1)?.outcome === 'FAILED') return report(false);

  const policy = syntheticPolicy({
    publicCode: draft.publicCode,
    agency,
    categories: draft.targetCategories,
    referenceDate: kigaliDate(config.now),
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
  });
  const versioned = await edge.post('/edge/v1/campaigns/policy', policy, key('policy'));
  steps.push(classify('policy', versioned.status, versioned.replayed, versioned.body));
  if (steps.at(-1)?.outcome === 'FAILED') return report(false);

  for (const session of staged.sessions) {
    const configured = await edge.post('/edge/v1/campaigns/session', session, key('session', session.district));
    steps.push(classify(`session ${session.district}`, configured.status, configured.replayed, configured.body));
  }
  if (steps.some((s) => s.outcome === 'FAILED')) return report(false);

  const published = await edge.post('/edge/v1/campaigns/publish', { publicCode: draft.publicCode }, key('publish'));
  steps.push(classify('publish', published.status, published.replayed, published.body));

  // 8. Prove it from the citizen's side: the public detail must serve it.
  const detail = await edge.get(`/edge/v1/campaigns/detail?publicCode=${encodeURIComponent(draft.publicCode)}`);
  const visible = detail.status === 200;
  steps.push({ step: 'public detail', outcome: visible ? 'APPLIED' : 'FAILED', httpStatus: detail.status, detail: visible ? 'citizens can see it' : codeOf(detail.body) || 'not visible' });
  return report(visible);
}

/** Plays every campaign of the scenario; one agency's failure does not stop the others. */
export async function conduct(scenario: Scenario, config: ConductorConfig): Promise<RehearsalReport> {
  const campaigns: CampaignReport[] = [];
  for (const staged of stageCampaigns(scenario, config.now)) {
    campaigns.push(await playCampaign(scenario, staged, config));
  }
  return {
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    title: scenario.title,
    kigaliDate: kigaliDate(config.now),
    ok: campaigns.every((c) => c.publiclyVisible && c.steps.every((s) => s.outcome !== 'FAILED')),
    campaigns,
  };
}
