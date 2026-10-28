// ══════════════════════════════════════════════════════════════════
// rehearsal — the SANDBOX JOURNEY (S12a quality bar, ADR-047)
//
// `pnpm rehearse --journey <scenario>`, on a running `pnpm sandbox`, after the
// scenario is staged. For every persona that names a g2g-sandbox catalogue
// persona, through the real edge only:
//
//   sign in (NID + DOB → NIDA lookup on the simulator; OTP read from the
//   sandbox SMS inbox) → apply (campaign code, category, NESA index) →
//   wait for the gates → the expected outcome:
//     ADMITTED          Exam Pass READY at the staged venue, then admitted at
//                       the gate by the scenario's screening officer;
//     REJECTED age/acad application REJECTED, the named gate INELIGIBLE;
//     ACADEMIC_PENDING  academic PENDING with the named failure code (e.g.
//                       NESA_RECORD_NOT_BOUND), never rejected.
//
// Output names persona ids and outcomes only: never a NID, a name, a phone or
// a date of birth (the private persona is labelled PRIVATE).
// ══════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EdgeSession, type EdgeResponse } from './edge.js';
import type { JourneyExpectation } from './scenario.js';

export interface JourneySubject {
  /** Persona id for the report (catalogue id or PRIVATE). */
  readonly label: string;
  readonly nationalId: string;
  readonly dateOfBirth: string;
  readonly phone: string;
  readonly nesaIndexNumber: string | null;
  /** S12b: the Irembo clearance certificate number the persona gives after applying. */
  readonly clearanceNumber?: string | null;
  readonly category: string;
  readonly expect: JourneyExpectation;
}

export interface JourneyConfig {
  readonly edgeBaseUrl: string;
  readonly origin: string;
  readonly smsInbox: string;
  readonly campaignCode: string;
  readonly gateOfficer: { readonly loginHandle: string; readonly password: string };
  readonly reader: { readonly loginHandle: string; readonly password: string };
  readonly pipelineTimeoutMs?: number;
}

export interface JourneyStep {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Render an operational value for a report line (never a personal value: callers pass statuses and codes). */
const txt = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v.toString() : v === null || v === undefined ? '' : JSON.stringify(v));
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** "***NN": the inbox's masked destination for a local number. */
function masked(phone: string): string {
  return `***${phone.slice(-2)}`;
}

async function otpFromInbox(inbox: string, phone: string, since: number, timeoutMs = 20_000): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(inbox)) {
      const lines = readFileSync(inbox, 'utf8').trim().split('\n').reverse();
      for (const line of lines) {
        if (line === '') continue;
        const entry = JSON.parse(line) as { at: string; destinationMasked: string; body: string };
        if (Date.parse(entry.at) < since) break;
        const match = entry.destinationMasked === masked(phone) ? /\b(\d{6})\b/.exec(entry.body) : null;
        if (match?.[1] !== undefined) return match[1];
      }
    }
    await sleep(500);
  }
  return null;
}

const statusOf = (r: EdgeResponse): string => `${txt(r.status)} ${txt(rec(r.body)['error'] ?? rec(r.body)['status'] ?? '')}`.trim();

/** POST, waiting out the edge's per-client rate limit (429 is never a verdict): up to 3 attempts, 61 s apart. */
async function postPaced(session: EdgeSession, path: string, body: unknown): Promise<EdgeResponse> {
  let response = await session.post(path, body);
  for (let attempt = 1; attempt < 3 && response.status === 429; attempt += 1) {
    await sleep(61_000);
    response = await session.post(path, body);
  }
  return response;
}

/** Drive one persona end to end. Returns the steps (no personal values in any detail). */
export async function runJourney(subject: JourneySubject, config: JourneyConfig): Promise<readonly JourneyStep[]> {
  const steps: JourneyStep[] = [];
  const note = (step: string, ok: boolean, detail = ''): boolean => { steps.push({ step, ok, detail }); return ok; };
  const citizen = new EdgeSession(config.edgeBaseUrl, config.origin);
  await citizen.get('/edge/v1/session');

  // 1. NID + DOB → NIDA (simulator) → onboarding token.
  const begin = await postPaced(citizen, '/edge/v1/auth/applicant/identity', { nationalId: subject.nationalId, dateOfBirth: subject.dateOfBirth });
  const token = rec(begin.body)['onboardingToken'];
  if (!note('NIDA lookup and onboarding', begin.status >= 200 && begin.status < 300 && typeof token === 'string', statusOf(begin))) return steps;

  // 2. OTP through the sandbox SMS inbox.
  const since = Date.now() - 1_000;
  const request = await postPaced(citizen, '/edge/v1/auth/applicant/otp/request', { onboardingToken: token, phoneNumber: subject.phone });
  if (!note('OTP requested', request.status >= 200 && request.status < 300, statusOf(request))) return steps;
  const otp = await otpFromInbox(config.smsInbox, subject.phone, since);
  if (!note('OTP read from the sandbox inbox', otp !== null, otp === null ? 'no code arrived' : '')) return steps;
  const verify = await postPaced(citizen, '/edge/v1/auth/applicant/otp/verify', { onboardingToken: token, phoneNumber: subject.phone, otp });
  if (!note('signed in', verify.status >= 200 && verify.status < 300, statusOf(verify))) return steps;

  // 3. Apply.
  const body: Record<string, string> = { campaignCode: config.campaignCode, category: subject.category };
  if (subject.nesaIndexNumber !== null) body['nesaIndexNumber'] = subject.nesaIndexNumber;
  const submit = await citizen.post('/edge/v1/me/applications', body, randomUUID());
  const submitted = (submit.status >= 200 && submit.status < 300) || rec(submit.body)['error'] === 'ALREADY_APPLIED';
  if (!note('application submitted', submitted, statusOf(submit))) return steps;
  const mine = await citizen.get('/edge/v1/me/applications');
  const rows = Array.isArray(mine.body) ? (mine.body as Record<string, unknown>[]) : [];
  const app = rows.filter((r) => typeof r['applicationId'] === 'string').sort((a, b) => txt(b['submittedAt'] ?? '').localeCompare(txt(a['submittedAt'] ?? '')))[0];
  const applicationId = typeof app?.['applicationId'] === 'string' ? app['applicationId'] : null;
  if (!note('application listed', applicationId !== null)) return steps;

  const reader = new EdgeSession(config.edgeBaseUrl, config.origin);
  if (!note('reviewer signed in', await reader.signIn(config.reader.loginHandle, config.reader.password))) return steps;
  const detail = async (): Promise<Record<string, unknown>> => {
    const body = rec((await reader.get(`/edge/v1/applications/detail?applicationId=${applicationId ?? ''}`)).body);
    return rec(body['application'] ?? body);
  };
  const timeout = config.pipelineTimeoutMs ?? 150_000;
  const until = Date.now() + timeout;
  const expect = subject.expect;

  if (expect.outcome === 'CLEARANCE') return clearanceSteps(subject, expect, { citizen, reader, applicationId: applicationId ?? '', until, steps, note, detail });

  // 4. The gates, until the expected end state (or the timeout).
  let last: Record<string, unknown> = {};
  let invitation: Record<string, unknown> = {};
  while (Date.now() < until) {
    last = await detail();
    if (expect.outcome === 'ADMITTED') {
      invitation = rec((await citizen.get(`/edge/v1/me/applications/exam-invitation?applicationId=${applicationId ?? ''}`)).body);
      if (invitation['state'] === 'READY' || invitation['state'] === 'ADMITTED' || last['status'] === 'REJECTED') break;
    } else if (expect.outcome === 'BOUND') {
      const code = rec(last['academicEligibilityDetail'])['failureCode'];
      if (last['academicStatus'] === 'ELIGIBLE' || last['academicStatus'] === 'INELIGIBLE' || code !== undefined) break;
    } else if (expect.outcome === 'REJECTED') {
      if (last['status'] === 'REJECTED') break;
    } else {
      const code = rec(last['academicEligibilityDetail'])['failureCode'];
      if (code === expect.failureCode || last['status'] === 'REJECTED') break;
    }
    await sleep(2_000);
  }
  const trail = `status ${txt(last['status'])}, age ${txt(last['ageEligibilityStatus'])}, academic ${txt(last['academicStatus'])}, criminal ${txt(last['criminalClearanceStatus'])}`;

  if (expect.outcome === 'BOUND') {
    // The private run: the record must bind to the identity. Report only pass/fail.
    const code = rec(last['academicEligibilityDetail'])['failureCode'];
    note('NESA record bound to the identity', (last['academicStatus'] === 'ELIGIBLE' || last['academicStatus'] === 'INELIGIBLE' || (code !== undefined && code !== 'NESA_RECORD_NOT_BOUND')), `academic ${txt(last['academicStatus'])}, failureCode ${txt(code ?? 'none')}`);
    return steps;
  }
  if (expect.outcome === 'REJECTED') {
    const gateStatus = expect.gate === 'AGE' ? last['ageEligibilityStatus'] : last['academicStatus'];
    note(`refused at the ${expect.gate.toLowerCase()} gate`, last['status'] === 'REJECTED' && gateStatus === 'INELIGIBLE', trail);
    return steps;
  }
  if (expect.outcome === 'ACADEMIC_PENDING') {
    const code = rec(last['academicEligibilityDetail'])['failureCode'];
    note(`academic PENDING with ${expect.failureCode}, not rejected`, last['academicStatus'] === 'PENDING' && code === expect.failureCode && last['status'] !== 'REJECTED', `${trail}, failureCode ${txt(code)}`);
    return steps;
  }

  // ADMITTED: Exam Pass READY, then the gate officer admits.
  const inv = rec(invitation['invitation']);
  if (invitation['state'] === 'ADMITTED') return [...steps, { step: 'already admitted (same-day re-run)', ok: true, detail: trail }];
  if (!note('Exam Pass READY', invitation['state'] === 'READY' && typeof inv['qrPayload'] === 'string', `${trail}, pass ${txt(invitation['state'])}`)) return steps;
  const gate = new EdgeSession(config.edgeBaseUrl, config.origin);
  if (!note('gate officer signed in', await gate.signIn(config.gateOfficer.loginHandle, config.gateOfficer.password))) return steps;
  const admit = await gate.post('/edge/v1/gate/admissions', { qrToken: inv['qrPayload'], nationalId: subject.nationalId, gateVenueName: inv['venueName'] });
  note('admitted at the gate', admit.status >= 200 && admit.status < 300 && rec(admit.body)['outcome'] === 'ADMITTED', `${statusOf(admit)} at ${txt(inv['venueName'])}`);
  const after = rec((await citizen.get(`/edge/v1/me/applications/exam-invitation?applicationId=${applicationId ?? ''}`)).body);
  note('the citizen sees ADMITTED', after['state'] === 'ADMITTED', txt(after['state']));
  return steps;
}

type ClearanceExpectation = Extract<JourneyExpectation, { outcome: 'CLEARANCE' }>;

interface ClearanceContext {
  readonly citizen: EdgeSession;
  readonly reader: EdgeSession;
  readonly applicationId: string;
  readonly until: number;
  readonly steps: JourneyStep[];
  readonly note: (step: string, ok: boolean, detail?: string) => boolean;
  readonly detail: () => Promise<Record<string, unknown>>;
}

/** The clearance item of a checklist body (the RIB-verified paper), or {}. */
function clearanceItem(body: unknown): Record<string, unknown> {
  const items = rec(body)['items'];
  const item = Array.isArray(items) ? (items as Record<string, unknown>[]).find((i) => i['registry'] === 'RIB') : undefined;
  return rec(item?.['clearance']);
}

/**
 * S12b: give the certificate number, wait for the checklist state, then check
 * the officer's view and the amber queue. Output: states and closed codes only.
 */
async function clearanceSteps(subject: JourneySubject, expect: ClearanceExpectation, ctx: ClearanceContext): Promise<readonly JourneyStep[]> {
  const { citizen, reader, applicationId, until, steps, note, detail } = ctx;
  if (subject.clearanceNumber === null || subject.clearanceNumber === undefined) { note('a clearance number to give', false, 'the persona has no certificate'); return steps; }

  const before = rec(clearanceItem((await citizen.get(`/edge/v1/me/applications/document-checklist?applicationId=${applicationId}`)).body));
  note('clearance outstanding before a number is given', before['state'] === 'NUMBER_REQUIRED' || before['state'] === 'VERIFIED', txt(before['state']));

  const malformed = await citizen.post('/edge/v1/me/applications/clearance-certificate', { applicationId, clearanceCertificateNumber: 'not-a-number' });
  note('a malformed number is refused where it can be corrected', malformed.status === 422 && rec(malformed.body)['error'] === 'CLEARANCE_NUMBER_MALFORMED', statusOf(malformed));

  const attach = await citizen.post('/edge/v1/me/applications/clearance-certificate', { applicationId, clearanceCertificateNumber: subject.clearanceNumber });
  if (!note('certificate number accepted', attach.status === 202 || attach.status === 200, statusOf(attach))) return steps;

  let item: Record<string, unknown> = {};
  let checklistBody: unknown = null;
  while (Date.now() < until) {
    checklistBody = (await citizen.get(`/edge/v1/me/applications/document-checklist?applicationId=${applicationId}`)).body;
    item = clearanceItem(checklistBody);
    if (item['state'] === expect.clearance && (expect.code === undefined || item['code'] === expect.code)) break;
    await sleep(2_000);
  }
  note(`checklist clearance ${expect.clearance}${expect.code === undefined ? '' : ` (${expect.code})`}`, item['state'] === expect.clearance && (expect.code === undefined || item['code'] === expect.code), `state ${txt(item['state'])}, code ${txt(item['code'] ?? 'none')}`);
  note('the citizen is never told why an officer is looking (no reasons)', !('reasons' in item) && !JSON.stringify(checklistBody).includes('IDENTITY_'), '');

  const last = await detail();
  const wantCriminal = expect.clearance === 'VERIFIED' ? 'CLEARED' : expect.clearance === 'UNDER_OFFICER_REVIEW' ? 'UNDER_REVIEW' : 'PENDING';
  note(`criminal gate ${wantCriminal}, application not rejected`, last['criminalClearanceStatus'] === wantCriminal && last['status'] !== 'REJECTED', `status ${txt(last['status'])}, criminal ${txt(last['criminalClearanceStatus'])}`);

  const queue = await reader.get('/edge/v1/applications/amber-queue');
  const rows = Array.isArray(queue.body) ? (queue.body as Record<string, unknown>[]) : [];
  const mine = rows.find((r) => r['applicationId'] === applicationId);
  if (expect.queueReasons !== undefined) {
    const reasons = mine?.['reasons'];
    const got = Array.isArray(reasons) ? [...(reasons as string[])].sort() : null;
    note(`amber queue reasons ${expect.queueReasons.join(',')}`, got !== null && JSON.stringify(got) === JSON.stringify([...expect.queueReasons].sort()), `got ${txt(got)}`);
    const officerChecklist = rec(clearanceItem((await reader.get(`/edge/v1/applications/document-checklist?applicationId=${applicationId}`)).body));
    note('the officer checklist carries the same reasons', JSON.stringify(officerChecklist['reasons']) === JSON.stringify([...expect.queueReasons].sort()), txt(officerChecklist['reasons']));
  } else {
    note('not in the amber queue for clearance', mine === undefined, mine === undefined ? '' : `reasons ${txt(mine['reasons'])}`);
  }
  return steps;
}
