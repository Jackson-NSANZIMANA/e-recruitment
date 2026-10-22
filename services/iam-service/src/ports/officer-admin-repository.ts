// ══════════════════════════════════════════════════════════════════
// iam-service — OfficerAdminRepository port (ADR-036)
//
// The officer-lifecycle commands, abstracted. Every method maps 1:1 to a
// rls/0033 SECURITY DEFINER function; the adapter binds the verified actor
// to the transaction. Business refusals are RETURN VALUES; only an
// infrastructure fault or an authorization failure in the database throws.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';
import type {
  ActivationCode,
  AssignablePost,
  OfficerRefusal,
  OfficerView,
} from '../domain/officer-admin.js';

/** Who is acting: the verified token subject and agency, never the request body. */
export interface OfficerAdminActor {
  readonly actorId: string;
  readonly agency: Agency;
  readonly correlationId: string;
}

export type Refused = { readonly outcome: 'REFUSED'; readonly reason: OfficerRefusal };

/** Create and reissue open a pending activation; they never return a code (four-eyes). */
export type CreateOfficerResult = { readonly outcome: 'CREATED'; readonly officer: OfficerView } | Refused;

export type ReissueActivationResult = { readonly outcome: 'REISSUED'; readonly officer: OfficerView } | Refused;

/** The one-time release to a DIFFERENT administrator: the only place a code is returned. */
export type ReleaseActivationResult =
  | { readonly outcome: 'RELEASED'; readonly officer: OfficerView; readonly activation: ActivationCode }
  | Refused;

export type OfficerChangeResult =
  | {
      readonly outcome: 'ASSIGNED' | 'DISABLED' | 'ENABLED' | 'REVOKED' | 'UNCHANGED';
      readonly officer: OfficerView;
      readonly sessionsRevoked: number;
    }
  | Refused;

export type ActivateOfficerResult = { readonly outcome: 'ACTIVATED' } | { readonly outcome: 'REJECTED' };

export interface OfficerAdminRepository {
  list(actor: OfficerAdminActor): Promise<readonly OfficerView[]>;
  create(actor: OfficerAdminActor, loginHandle: string, posts: readonly AssignablePost[]): Promise<CreateOfficerResult>;
  reissueActivation(actor: OfficerAdminActor, officerId: string): Promise<ReissueActivationResult>;
  releaseActivation(actor: OfficerAdminActor, officerId: string): Promise<ReleaseActivationResult>;
  assignPosts(
    actor: OfficerAdminActor,
    officerId: string,
    posts: readonly AssignablePost[],
    reasonCode: string,
  ): Promise<OfficerChangeResult>;
  setStatus(
    actor: OfficerAdminActor,
    officerId: string,
    status: 'active' | 'disabled',
    reasonCode: string,
  ): Promise<OfficerChangeResult>;
  revokeSessions(actor: OfficerAdminActor, officerId: string, reasonCode: string): Promise<OfficerChangeResult>;
  /** Anonymous: the activation code is the credential. `credential` is a scrypt digest. */
  activate(loginHandle: string, activationCode: string, credential: string, correlationId: string): Promise<ActivateOfficerResult>;
}
