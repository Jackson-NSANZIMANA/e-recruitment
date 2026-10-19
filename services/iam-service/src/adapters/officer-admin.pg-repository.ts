// ══════════════════════════════════════════════════════════════════
// iam-service — OfficerAdminRepository adapter (PostgreSQL, ADR-036)
//
// Every call is one transaction: SET LOCAL ROLE usrp_iam_service, bind the
// verified actor to the transaction-local usrp.officer_actor_id, then call the
// rls/0033 SECURITY DEFINER function. usrp_iam_service holds NO write grant on
// the credential store; the function owner does, and it re-checks the actor's
// live account row (active agency_admin of this agency) before anything.
//
// SQLSTATE 42501 from a function is an authorization refusal of the actor and
// becomes OfficerAdminForbiddenError (→ 403); anything else that throws is an
// infrastructure fault (→ IamPersistenceError → 500). Business refusals come
// back as data. Nothing returned here carries a credential or a code hash;
// the one-time activation code is returned only by create/reissue.
// ══════════════════════════════════════════════════════════════════

import { sql, type SqlTransaction } from '@usrp/shared-database';
import {
  OFFICER_REFUSALS,
  type ActivationCode,
  type AssignablePost,
  type OfficerRefusal,
  type OfficerStatus,
  type OfficerView,
} from '../domain/officer-admin.js';
import { IamPersistenceError, OfficerAdminForbiddenError } from '../domain/iam.errors.js';
import type {
  ActivateOfficerResult,
  CreateOfficerResult,
  OfficerAdminActor,
  OfficerAdminRepository,
  OfficerChangeResult,
  ReissueActivationResult,
} from '../ports/officer-admin-repository.js';

const IAM_DB_ROLE = 'usrp_iam_service';
const CHANGE_OUTCOMES = new Set(['ASSIGNED', 'DISABLED', 'ENABLED', 'REVOKED', 'UNCHANGED']);

type Row = Record<string, unknown>;
type ResultRows = { result: unknown }[];

function asRecord(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IamPersistenceError('Officer command returned an unexpected shape');
  }
  return value as Row;
}

function instant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && !(value instanceof Date)) {
    throw new IamPersistenceError('Officer command returned an unexpected timestamp');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new IamPersistenceError('Officer command returned an unexpected timestamp');
  return date.toISOString();
}

function status(value: unknown): OfficerStatus {
  if (value === 'active' || value === 'disabled' || value === 'pending') return value;
  throw new IamPersistenceError('Officer command returned an unknown status');
}

/** Rebuild the view from the allowlisted fields only. */
function toView(raw: unknown): OfficerView {
  const row = asRecord(raw);
  const posts = row['posts'];
  if (typeof row['officerId'] !== 'string' || typeof row['loginHandle'] !== 'string' ||
      !Array.isArray(posts) || !posts.every((p): p is string => typeof p === 'string')) {
    throw new IamPersistenceError('Officer command returned an unexpected officer');
  }
  const createdAt = instant(row['createdAt']);
  if (createdAt === null) throw new IamPersistenceError('Officer command returned no creation time');
  return {
    officerId: row['officerId'],
    loginHandle: row['loginHandle'],
    posts,
    status: status(row['status']),
    createdAt,
    activatedAt: instant(row['activatedAt']),
    lastLoginAt: instant(row['lastLoginAt']),
    activationExpiresAt: instant(row['activationExpiresAt']),
  };
}

function toActivation(raw: unknown): ActivationCode {
  const row = asRecord(raw);
  const expiresAt = instant(row['expiresAt']);
  if (typeof row['code'] !== 'string' || expiresAt === null) {
    throw new IamPersistenceError('Officer command returned an unexpected activation code');
  }
  return { code: row['code'], expiresAt };
}

function refusal(row: Row): OfficerRefusal {
  const reason = row['reason'];
  if (typeof reason === 'string' && (OFFICER_REFUSALS as readonly string[]).includes(reason)) {
    return reason as OfficerRefusal;
  }
  throw new IamPersistenceError('Officer command returned an unknown refusal');
}

function isForbidden(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '42501';
}

export class PgOfficerAdminRepository implements OfficerAdminRepository {
  /** One transaction as usrp_iam_service, with the actor bound when there is one. */
  async #run(actor: OfficerAdminActor | null, run: (tx: SqlTransaction) => Promise<ResultRows>): Promise<unknown> {
    let rows: ResultRows;
    try {
      rows = await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(IAM_DB_ROLE)}`;
        if (actor !== null) {
          await tx`SELECT set_config('usrp.officer_actor_id', ${actor.actorId}, true)`;
        }
        return run(tx);
      });
    } catch (err) {
      if (actor !== null && isForbidden(err)) throw new OfficerAdminForbiddenError({ cause: err });
      throw new IamPersistenceError('Officer command failed', { cause: err });
    }
    return rows[0]?.result;
  }

  async list(actor: OfficerAdminActor): Promise<readonly OfficerView[]> {
    const list = await this.#run(actor, (tx) => tx<ResultRows>`
      SELECT public_core.officer_list(${actor.actorId}::uuid, ${actor.agency}::public_core.agency) AS result
    `);
    if (!Array.isArray(list)) throw new IamPersistenceError('Officer list returned an unexpected shape');
    return list.map(toView);
  }

  async create(actor: OfficerAdminActor, loginHandle: string, posts: readonly AssignablePost[]): Promise<CreateOfficerResult> {
    const row = asRecord(await this.#run(actor, (tx) => tx<ResultRows>`
      SELECT public_core.officer_create(
        ${actor.actorId}::uuid, ${actor.agency}::public_core.agency, ${loginHandle},
        ${tx.array([...posts])}::text[], ${actor.correlationId}
      ) AS result
    `));
    if (row['outcome'] === 'CREATED') {
      return { outcome: 'CREATED', officer: toView(row['officer']), activation: toActivation(row['activation']) };
    }
    if (row['outcome'] === 'REFUSED') return { outcome: 'REFUSED', reason: refusal(row) };
    throw new IamPersistenceError('Officer create returned an unknown outcome');
  }

  async reissueActivation(actor: OfficerAdminActor, officerId: string): Promise<ReissueActivationResult> {
    const row = asRecord(await this.#run(actor, (tx) => tx<ResultRows>`
      SELECT public_core.officer_reissue_activation(
        ${actor.actorId}::uuid, ${actor.agency}::public_core.agency, ${officerId}::uuid, ${actor.correlationId}
      ) AS result
    `));
    if (row['outcome'] === 'REISSUED') {
      return { outcome: 'REISSUED', officer: toView(row['officer']), activation: toActivation(row['activation']) };
    }
    if (row['outcome'] === 'REFUSED') return { outcome: 'REFUSED', reason: refusal(row) };
    throw new IamPersistenceError('Activation reissue returned an unknown outcome');
  }

  #change(raw: unknown): OfficerChangeResult {
    const row = asRecord(raw);
    const outcome = row['outcome'];
    if (outcome === 'REFUSED') return { outcome: 'REFUSED', reason: refusal(row) };
    if (typeof outcome !== 'string' || !CHANGE_OUTCOMES.has(outcome) || typeof row['sessionsRevoked'] !== 'number') {
      throw new IamPersistenceError('Officer command returned an unknown outcome');
    }
    return {
      outcome: outcome as 'ASSIGNED' | 'DISABLED' | 'ENABLED' | 'REVOKED' | 'UNCHANGED',
      officer: toView(row['officer']),
      sessionsRevoked: row['sessionsRevoked'],
    };
  }

  async assignPosts(
    actor: OfficerAdminActor,
    officerId: string,
    posts: readonly AssignablePost[],
    reasonCode: string,
  ): Promise<OfficerChangeResult> {
    return this.#change(await this.#run(actor, (tx) => tx<ResultRows>`
      SELECT public_core.officer_assign_posts(
        ${actor.actorId}::uuid, ${actor.agency}::public_core.agency, ${officerId}::uuid,
        ${tx.array([...posts])}::text[], ${reasonCode}, ${actor.correlationId}
      ) AS result
    `));
  }

  async setStatus(
    actor: OfficerAdminActor,
    officerId: string,
    target: 'active' | 'disabled',
    reasonCode: string,
  ): Promise<OfficerChangeResult> {
    return this.#change(await this.#run(actor, (tx) => tx<ResultRows>`
      SELECT public_core.officer_set_status(
        ${actor.actorId}::uuid, ${actor.agency}::public_core.agency, ${officerId}::uuid,
        ${target}, ${reasonCode}, ${actor.correlationId}
      ) AS result
    `));
  }

  async revokeSessions(actor: OfficerAdminActor, officerId: string, reasonCode: string): Promise<OfficerChangeResult> {
    return this.#change(await this.#run(actor, (tx) => tx<ResultRows>`
      SELECT public_core.officer_revoke_sessions(
        ${actor.actorId}::uuid, ${actor.agency}::public_core.agency, ${officerId}::uuid,
        ${reasonCode}, ${actor.correlationId}
      ) AS result
    `));
  }

  async activate(loginHandle: string, activationCode: string, credential: string, correlationId: string): Promise<ActivateOfficerResult> {
    const row = asRecord(await this.#run(null, (tx) => tx<ResultRows>`
      SELECT public_core.officer_activate(${loginHandle}, ${activationCode}, ${credential}, ${correlationId}) AS result
    `));
    if (row['outcome'] === 'ACTIVATED') return { outcome: 'ACTIVATED' };
    if (row['outcome'] === 'REJECTED') return { outcome: 'REJECTED' };
    throw new IamPersistenceError('Officer activation returned an unknown outcome');
  }
}
