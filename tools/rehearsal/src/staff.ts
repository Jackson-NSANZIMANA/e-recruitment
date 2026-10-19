// ══════════════════════════════════════════════════════════════════
// rehearsal — the `staff` step (ADR-036)
//
// Each scenario campaign names the station officers its day needs. They are
// provisioned THROUGH THE OFFICER-LIFECYCLE OPERATIONS, as the agency
// administrator, at the edge — exactly what S06's staff screen will call:
//
//   listOfficers → createOfficer (one-time code) → activateOfficer (as the
//   officer, anonymous) → assignOfficerPosts when the posts differ →
//   enableOfficer / reissueOfficerActivation to recover an earlier run.
//
// Then it verifies from the list, not from its own bookkeeping: every
// scenario officer exists, is active and holds EXACTLY its posts. The dev
// seeder is no longer how a rehearsal gets its staff.
// ══════════════════════════════════════════════════════════════════

import type { EdgeSession } from './edge.js';

/** DEV-ONLY, documented like the administrator's RehearsalAdmin#2026. */
export const REHEARSAL_STAFF_PASSWORD = 'RehearsalStaff#2026';

export interface StaffMember {
  readonly handle: string;
  readonly posts: readonly string[];
}

export interface ListedOfficer {
  readonly officerId: string;
  readonly loginHandle: string;
  readonly posts: readonly string[];
  readonly status: 'active' | 'disabled' | 'pending';
}

export type StaffAction =
  | { readonly kind: 'CREATE' }
  | { readonly kind: 'ENABLE'; readonly officerId: string }
  | { readonly kind: 'REISSUE'; readonly officerId: string }
  | { readonly kind: 'ASSIGN'; readonly officerId: string }
  | { readonly kind: 'NONE'; readonly officerId: string };

export interface StaffOutcome {
  readonly handle: string;
  readonly ok: boolean;
  readonly applied: boolean;
  readonly detail: string;
}

/** PURE. Post sets compare as sets. */
export function samePosts(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join(',') === [...b].sort().join(',');
}

/**
 * PURE. What to do next for one scenario officer given the agency's list.
 * Called repeatedly (state changes after each step) until it answers NONE.
 */
export function nextStaffAction(member: StaffMember, existing: readonly ListedOfficer[]): StaffAction {
  const found = existing.find((o) => o.loginHandle === member.handle);
  if (found === undefined) return { kind: 'CREATE' };
  if (found.status === 'disabled') return { kind: 'ENABLE', officerId: found.officerId };
  if (found.status === 'pending') return { kind: 'REISSUE', officerId: found.officerId };
  if (!samePosts(found.posts, member.posts)) return { kind: 'ASSIGN', officerId: found.officerId };
  return { kind: 'NONE', officerId: found.officerId };
}

function errorOf(body: unknown): string {
  if (body !== null && typeof body === 'object') {
    const error = (body as Record<string, unknown>)['error'];
    if (typeof error === 'string') return error;
  }
  return '';
}

function isListed(value: unknown): value is ListedOfficer {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return typeof o['officerId'] === 'string' && typeof o['loginHandle'] === 'string' &&
    Array.isArray(o['posts']) && (o['status'] === 'active' || o['status'] === 'disabled' || o['status'] === 'pending');
}

function listedFrom(body: unknown): ListedOfficer[] | null {
  const officers = (body as { officers?: unknown } | null)?.officers;
  return Array.isArray(officers) ? officers.filter(isListed) : null;
}

function activationCodeOf(body: unknown): string | null {
  const code = (body as { activation?: { code?: unknown } } | null)?.activation?.code;
  return typeof code === 'string' ? code : null;
}

/** Provision one agency's scenario staff as its signed-in administrator. */
export async function provisionStaff(
  admin: EdgeSession,
  newBrowser: () => EdgeSession,
  staff: readonly StaffMember[],
): Promise<readonly StaffOutcome[]> {
  const activate = async (handle: string, code: string): Promise<boolean> => {
    const officer = newBrowser();
    await officer.get('/edge/v1/session');
    const reply = await officer.post('/edge/v1/auth/officer/activate', {
      loginHandle: handle,
      activationCode: code,
      password: REHEARSAL_STAFF_PASSWORD,
    });
    return reply.status === 204;
  };

  const outcomes: StaffOutcome[] = [];
  for (const member of staff) {
    let applied = false;
    let failure: string | null = null;
    // At most three transitions are ever needed (enable → reissue+activate → assign).
    for (let step = 0; step < 5 && failure === null; step += 1) {
      const list = await admin.get('/edge/v1/officers');
      const existing = listedFrom(list.body);
      if (list.status !== 200 || existing === null) {
        failure = `listOfficers answered ${String(list.status)} ${errorOf(list.body)}`.trim();
        break;
      }
      const action = nextStaffAction(member, existing);
      if (action.kind === 'NONE') break;
      applied = true;
      if (action.kind === 'CREATE') {
        const created = await admin.post('/edge/v1/officers', { loginHandle: member.handle, posts: member.posts });
        const code = activationCodeOf(created.body);
        if (created.status !== 201 || code === null) failure = `createOfficer answered ${String(created.status)} ${errorOf(created.body)}`.trim();
        else if (!(await activate(member.handle, code))) failure = 'activateOfficer refused the fresh code';
      } else if (action.kind === 'REISSUE') {
        const reissued = await admin.post('/edge/v1/officers/activation/reissue', { targetOfficerId: action.officerId });
        const code = activationCodeOf(reissued.body);
        if (reissued.status !== 200 || code === null) failure = `reissueOfficerActivation answered ${String(reissued.status)} ${errorOf(reissued.body)}`.trim();
        else if (!(await activate(member.handle, code))) failure = 'activateOfficer refused the reissued code';
      } else if (action.kind === 'ENABLE') {
        const enabled = await admin.post('/edge/v1/officers/enable', { targetOfficerId: action.officerId, reasonCode: 'RETURNED_TO_DUTY' });
        if (enabled.status !== 200) failure = `enableOfficer answered ${String(enabled.status)} ${errorOf(enabled.body)}`.trim();
      } else {
        const assigned = await admin.post('/edge/v1/officers/posts', { targetOfficerId: action.officerId, posts: member.posts, reasonCode: 'CORRECTION' });
        if (assigned.status !== 200) failure = `assignOfficerPosts answered ${String(assigned.status)} ${errorOf(assigned.body)}`.trim();
      }
    }
    outcomes.push(failure === null
      ? { handle: member.handle, ok: true, applied, detail: applied ? 'provisioned through the officer operations' : 'already in place' }
      : { handle: member.handle, ok: false, applied, detail: failure });
  }

  // The expectation, verified from the agency's own list: active, exactly these posts.
  // (No sign-in probe per officer: activation's 204 already proved the
  // credential, and N extra logins would exhaust the edge's shared login limit.)
  const final = listedFrom((await admin.get('/edge/v1/officers')).body) ?? [];
  const verified: StaffOutcome[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      verified.push(outcome);
      continue;
    }
    const member = staff.find((m) => m.handle === outcome.handle);
    const listed = final.find((o) => o.loginHandle === outcome.handle);
    if (member === undefined || listed === undefined || listed.status !== 'active' || !samePosts(listed.posts, member.posts)) {
      verified.push({ ...outcome, ok: false, detail: `listOfficers does not show ${outcome.handle} active with exactly ${member?.posts.join('+') ?? '?'}` });
      continue;
    }
    verified.push(outcome);
  }
  return verified;
}
