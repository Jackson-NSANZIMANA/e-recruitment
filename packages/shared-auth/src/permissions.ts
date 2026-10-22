// ══════════════════════════════════════════════════════════════════
// @usrp/shared-auth — The permission model (BUILD-004 §D)
//
// A valid officer token proves WHO and WHICH AGENCY. It must not be the whole
// of WHAT: a screening officer at a venue is not a medical board, and neither
// is the person who signs a final decision. Authorization is therefore a
// separate, explicit check — role → permission → operation — applied by the
// service that owns the operation (authoritative) and mirrored at the edge
// (fail fast, no upstream spend).
//
// SCOPE IS NOT HERE. A permission says "may perform this KIND of action". It
// never widens WHERE: the agency always comes from the verified principal and
// is enforced again by FORCE'd RLS. No role grants cross-agency reach.
//
// FAIL CLOSED. An unknown role grants nothing. An empty role list grants
// nothing. There is no wildcard and no "superadmin".
//
// THE TABLE BELOW IS A PROVISIONAL DEFAULT, NOT POLICY. Which post may sign a
// final decision is the agencies' decision (handbook §8: engineers flag
// authorization limits, they do not decide them). This file is the ONE place
// that mapping lives, so ratifying or changing it is a reviewed one-file edit.
// ══════════════════════════════════════════════════════════════════

import type { Principal } from './principal.js';

/** BUILD-001 campaign-control permissions (unchanged names). */
export const CAMPAIGN_PERMISSION_LIST = [
  'campaign.create',
  'campaign.policy.create',
  'campaign.session.configure',
  'campaign.publish',
  'campaign.registration.close',
  'campaign.complete',
  'campaign.cancel',
  'campaign.read.public',
  'campaign.read.admin',
] as const;

/** Recruitment-operation permissions (BUILD-002..004). */
export const OPERATION_PERMISSION_LIST = [
  /** Read the agency's application list, detail and status history. */
  'application.read',
  /** Read the amber (document-review) queue. */
  'adjudication.read',
  /** Register / vet a walk-in candidate on exam day (RDF lane). */
  'walkin.register',
  'walkin.vet',
  /** Establish an identity in person via the brokered NIDA check. */
  'identity.verify',
  /** Enrol a tablet; upload captured scores. */
  'field.device.enroll',
  /**
   * List the agency's field devices, bind one to a venue day, revoke one with a
   * reason (S09; owner decision 2026-10-21, ADR-036 addendum "S09 device
   * management"). field_supervisor and agency_admin.
   */
  'field.device.manage',
  'field.score.sync',
  /** Resolve a field-score conflict (authority over physical evidence). */
  'field.conflict.resolve',
  /** Exam-day biometric check-in. */
  'biometric.verify',
  /**
   * Clear a required document by seeing the paper at the venue (ADR-032,
   * owner decision 2026-10-14: the front-door check-in officer).
   */
  'document.verify.venue',
  /**
   * Admit a candidate at the venue gate: spend their single-use exam QR after
   * sighting the national ID card (BUILD-003, ADR-034). The same front-door
   * post as document.verify.venue.
   */
  'admission.gate',
  /** Record the medical board / certificate verdict. */
  'medical.review',
  /** Record an adjudication on an amber/red document review. */
  'adjudication.decide',
  /** Record the final recruitment decision. */
  'decision.final',
  /** Accept (enlist) a shortlisted applicant. */
  'application.accept',
  /** Data-protection office: see and decide erasure requests. */
  'erasure.queue.read',
  'erasure.decide',
] as const;

/**
 * Officer-lifecycle permissions (ADR-036). Account administration in the
 * caller's OWN agency; granted to agency_admin only. They confer no campaign
 * or decision power, and the rls/0033 command functions re-check the actor's
 * live database row on every call.
 */
export const OFFICER_ADMIN_PERMISSION_LIST = [
  /** List the agency's officers: handle, posts, status, created, last login. */
  'officer.read',
  /** Create an officer (one-time activation code) or re-issue an unredeemed code. */
  'officer.create',
  /** Replace an officer's posts (never agency_admin). */
  'officer.posts.assign',
  /** Disable or re-enable an officer account. */
  'officer.disable',
  /** End every browser session of an officer now. */
  'officer.sessions.revoke',
] as const;

/**
 * Biometric identity evidence permissions (ADR-037). Recording evidence
 * reuses `biometric.verify` (screening_officer). Reading ADVISORY evidence is
 * for reviewers; confirming identity after a NO_MATCH / INCONCLUSIVE result
 * is the field supervisor's alone (owner decision 2026-10-19), and the gate
 * refuses to count a confirmation by the admitting officer.
 */
export const BIOMETRIC_EVIDENCE_PERMISSION_LIST = [
  /** Read ADVISORY biometric evidence on the officer application detail. */
  'biometric.evidence.read',
  /** Confirm a candidate's identity after negative biometric evidence. */
  'identity.manual.confirm',
] as const;

export const ALL_PERMISSIONS = [
  ...CAMPAIGN_PERMISSION_LIST,
  ...OPERATION_PERMISSION_LIST,
  ...OFFICER_ADMIN_PERMISSION_LIST,
  ...BIOMETRIC_EVIDENCE_PERMISSION_LIST,
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];
export type OperationPermission = (typeof OPERATION_PERMISSION_LIST)[number];
export type OfficerAdminPermission = (typeof OFFICER_ADMIN_PERMISSION_LIST)[number];
export type BiometricEvidencePermission = (typeof BIOMETRIC_EVIDENCE_PERMISSION_LIST)[number];

/**
 * The role vocabulary. `agency_admin` and `reviewer` pre-date this module
 * (BUILD-001); the rest name the posts an examination day actually has.
 */
export const KNOWN_ROLES = [
  'agency_admin',
  'reviewer',
  'screening_officer',
  'field_supervisor',
  'medical_officer',
  'adjudicator',
  'decision_authority',
  'dpo',
] as const;

export type KnownRole = (typeof KNOWN_ROLES)[number];

const READ: readonly Permission[] = ['application.read', 'adjudication.read'];

/**
 * role → permissions. PROVISIONAL (see header). Deliberately narrow:
 *   • field.device.manage (S09, owner decision 2026-10-21, ADR-036 addendum
 *     "S09 device management") is held by field_supervisor and agency_admin
 *     only: list devices, assign a device to a venue day, revoke with a reason.
 *     Enrolment (field.device.enroll) stays with the screening officer.
 *   • agency_admin  runs the campaign; does NOT decide candidates.
 *   • reviewer      read-only.
 *   • decision_authority is the only post that may finalise and accept.
 */
const ROLE_PERMISSIONS: Readonly<Record<KnownRole, ReadonlySet<Permission>>> = {
  agency_admin: new Set<Permission>([
    'campaign.create',
    'campaign.policy.create',
    'campaign.session.configure',
    'campaign.publish',
    'campaign.registration.close',
    'campaign.complete',
    'campaign.cancel',
    'campaign.read.admin',
    'field.device.manage',
    ...READ,
    ...OFFICER_ADMIN_PERMISSION_LIST,
  ]),
  reviewer: new Set<Permission>(['campaign.read.admin', 'biometric.evidence.read', ...READ]),
  screening_officer: new Set<Permission>([
    'walkin.register',
    'walkin.vet',
    'identity.verify',
    'biometric.verify',
    'document.verify.venue',
    'admission.gate',
    'field.device.enroll',
    'field.score.sync',
    ...READ,
  ]),
  field_supervisor: new Set<Permission>([
    'field.device.enroll',
    'field.device.manage',
    'field.score.sync',
    'field.conflict.resolve',
    'biometric.evidence.read',
    'identity.manual.confirm',
    ...READ,
  ]),
  medical_officer: new Set<Permission>(['medical.review', ...READ]),
  adjudicator: new Set<Permission>(['adjudication.decide', 'biometric.evidence.read', ...READ]),
  decision_authority: new Set<Permission>(['decision.final', 'application.accept', 'biometric.evidence.read', ...READ]),
  dpo: new Set<Permission>(['erasure.queue.read', 'erasure.decide']),
};

function isKnownRole(role: string): role is KnownRole {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);
}

/** PURE. True iff any held role grants `permission`. Unknown roles grant nothing. */
export function rolesHavePermission(roles: readonly string[], permission: Permission): boolean {
  // The public read is for anonymous callers; no officer role confers it.
  if (permission === 'campaign.read.public') return false;
  return roles.some((role) => isKnownRole(role) && ROLE_PERMISSIONS[role].has(permission));
}

/** PURE. Officers only; a system principal holds no human permission. */
export function principalHasPermission(principal: Principal, permission: Permission): boolean {
  return principal.kind === 'officer' && rolesHavePermission(principal.roles, permission);
}

/** Every permission a role set confers (for the session view; never a security input). */
export function permissionsForRoles(roles: readonly string[]): readonly Permission[] {
  return ALL_PERMISSIONS.filter((p) => rolesHavePermission(roles, p));
}
