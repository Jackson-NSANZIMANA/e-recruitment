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

/** Drive one persona end to end. Returns the steps (no personal values in any detail). */
export async function runJourney(subject: JourneySubject, config: JourneyConfig): Promise<readonly JourneyStep[]> {
  const steps: JourneyStep[] = [];
  const note = (step: string, ok: boolean, detail = ''): boolean => { steps.push({ step, ok, detail }); return ok; };
  const citizen = new EdgeSession(config.edgeBaseUrl, config.origin);
  await citizen.get('/edge/v1/session');

  // 1. NID + DOB → NIDA (simulator) → onboarding token.
  const begin = await citizen.post('/edge/v1/auth/applicant/identity', { nationalId: subject.nationalId, dateOfBirth: subject.dateOfBirth });
  const token = rec(begin.body)['onboardingToken'];
  if (!note('NIDA lookup and onboarding', begin.status >= 200 && begin.status < 300 && typeof token === 'string', statusOf(begin))) return steps;

  // 2. OTP through the sandbox SMS inbox.
  const since = Date.now() - 1_000;
  const request = await citizen.post('/edge/v1/auth/applicant/otp/request', { onboardingToken: token, phoneNumber: subject.phone });
  if (!note('OTP requested', request.status >= 200 && request.status < 300, statusOf(request))) return steps;
  const otp = await otpFromInbox(config.smsInbox, subject.phone, since);
  if (!note('OTP read from the sandbox inbox', otp !== null, otp === null ? 'no code arrived' : '')) return steps;
  const verify = await citizen.post('/edge/v1/auth/applicant/otp/verify', { onboardingToken: token, phoneNumber: subject.phone, otp });
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
