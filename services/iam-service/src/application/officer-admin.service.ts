// ══════════════════════════════════════════════════════════════════
// iam-service — Officer lifecycle use cases (ADR-036)
//
// The agency administrator's commands over officers of their OWN agency. The
// actor and the agency come from the verified principal only; the request
// carries a target officer id and the command's own fields, never an agency.
// Input is refused here when it is plainly invalid (pure domain); every rule
// is enforced again — authoritatively — by the rls/0033 functions, which also
// re-read the actor's live account. Business refusals are return values.
//
// Activation (the anonymous half) hashes the officer's chosen password with
// scrypt here; the plaintext never reaches the database or a log.
// ══════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { hashPassword } from '@usrp/shared-security';
import type { Agency } from '@usrp/shared-types';
import {
  ASSIGN_POSTS_REASONS,
  DISABLE_REASONS,
  ENABLE_REASONS,
  REVOKE_SESSIONS_REASONS,
  isAcceptablePassword,
  isReason,
  isSelfModification,
  isUuid,
  normaliseActivationCode,
  normaliseHandle,
  safeCorrelationId,
  validatePosts,
  type OfficerView,
} from '../domain/officer-admin.js';
import type {
  ActivateOfficerResult,
  CreateOfficerResult,
  OfficerAdminActor,
  OfficerAdminRepository,
  OfficerChangeResult,
  Refused,
  ReissueActivationResult,
} from '../ports/officer-admin-repository.js';

/** The verified caller, as the HTTP layer hands it over. */
export interface AdminPrincipal {
  readonly subjectId: string;
  readonly agency: Agency;
  readonly correlationId: string;
}

/** Shape errors (bad id) are a separate outcome from a business refusal. */
export type InvalidRequest = { readonly outcome: 'INVALID_REQUEST'; readonly field: string };

const refused = (reason: Refused['reason']): Refused => ({ outcome: 'REFUSED', reason });
const invalidTarget: InvalidRequest = { outcome: 'INVALID_REQUEST', field: 'targetOfficerId' };

export class OfficerAdminService {
  readonly #repository: OfficerAdminRepository;

  constructor(repository: OfficerAdminRepository) {
    this.#repository = repository;
  }

  #actor(principal: AdminPrincipal): OfficerAdminActor {
    return {
      actorId: principal.subjectId,
      agency: principal.agency,
      correlationId: safeCorrelationId(principal.correlationId, randomUUID()),
    };
  }

  list(principal: AdminPrincipal): Promise<readonly OfficerView[]> {
    return this.#repository.list(this.#actor(principal));
  }

  async create(principal: AdminPrincipal, loginHandle: unknown, posts: unknown): Promise<CreateOfficerResult> {
    const handle = normaliseHandle(loginHandle);
    if (handle === null) return refused('INVALID_HANDLE');
    const checked = validatePosts(posts);
    if (!checked.ok) return refused(checked.refusal);
    return this.#repository.create(this.#actor(principal), handle, checked.posts);
  }

  async reissueActivation(principal: AdminPrincipal, officerId: unknown): Promise<ReissueActivationResult | InvalidRequest> {
    if (!isUuid(officerId)) return invalidTarget;
    if (isSelfModification(principal.subjectId, officerId)) return refused('SELF_MODIFICATION');
    return this.#repository.reissueActivation(this.#actor(principal), officerId);
  }

  async assignPosts(
    principal: AdminPrincipal,
    officerId: unknown,
    posts: unknown,
    reasonCode: unknown,
  ): Promise<OfficerChangeResult | InvalidRequest> {
    if (!isUuid(officerId)) return invalidTarget;
    if (!isReason(ASSIGN_POSTS_REASONS, reasonCode)) return refused('INVALID_REASON');
    if (isSelfModification(principal.subjectId, officerId)) return refused('SELF_MODIFICATION');
    const checked = validatePosts(posts);
    if (!checked.ok) return refused(checked.refusal);
    return this.#repository.assignPosts(this.#actor(principal), officerId, checked.posts, reasonCode);
  }

  /**
   * Disable or enable. Self-modification is NOT pre-refused here for disable:
   * the database decides between LAST_ACTIVE_ADMIN and SELF_MODIFICATION,
   * because only it can count the agency's other active administrators.
   */
  async setStatus(
    principal: AdminPrincipal,
    officerId: unknown,
    target: 'active' | 'disabled',
    reasonCode: unknown,
  ): Promise<OfficerChangeResult | InvalidRequest> {
    if (!isUuid(officerId)) return invalidTarget;
    const reasons: readonly string[] = target === 'disabled' ? DISABLE_REASONS : ENABLE_REASONS;
    if (!isReason(reasons, reasonCode)) return refused('INVALID_REASON');
    if (target === 'active' && isSelfModification(principal.subjectId, officerId)) return refused('SELF_MODIFICATION');
    return this.#repository.setStatus(this.#actor(principal), officerId, target, reasonCode);
  }

  async revokeSessions(principal: AdminPrincipal, officerId: unknown, reasonCode: unknown): Promise<OfficerChangeResult | InvalidRequest> {
    if (!isUuid(officerId)) return invalidTarget;
    if (!isReason(REVOKE_SESSIONS_REASONS, reasonCode)) return refused('INVALID_REASON');
    if (isSelfModification(principal.subjectId, officerId)) return refused('SELF_MODIFICATION');
    return this.#repository.revokeSessions(this.#actor(principal), officerId, reasonCode);
  }

  /**
   * Anonymous activation. One indistinguishable REJECTED for a malformed
   * handle or code, an unknown handle, a wrong/expired/used code, or an
   * account that is not pending. A too-short password is a shape error the
   * officer can fix, so it is reported separately — before any lookup.
   */
  async activate(
    loginHandle: unknown,
    activationCode: unknown,
    password: unknown,
    correlationId: string,
  ): Promise<ActivateOfficerResult | { readonly outcome: 'WEAK_PASSWORD' }> {
    if (!isAcceptablePassword(password)) return { outcome: 'WEAK_PASSWORD' };
    const handle = normaliseHandle(loginHandle);
    const code = normaliseActivationCode(activationCode);
    if (handle === null || code === null) {
      // Same work as a real attempt, so a malformed input is not a timing oracle.
      hashPassword(password);
      return { outcome: 'REJECTED' };
    }
    return this.#repository.activate(handle, code, hashPassword(password), safeCorrelationId(correlationId, randomUUID()));
  }
}
