// ══════════════════════════════════════════════════════════════════
// edge-gateway — EdgeSessionStore adapter (PostgreSQL, rls/0019)
//
// Runs as usrp_edge_session_writer — a NOLOGIN group role with rights on
// public_core.edge_sessions and nothing else. The edge holds live credentials
// for every browser session; giving it usrp_system_service (which can read
// every applicant identity in the country) would make one compromise two.
//
// WHY POSTGRES AND NOT AN IN-PROCESS MAP:
//   • a restart must not sign out every officer mid-shift;
//   • the tier is a single point of failure for all browser traffic and must
//     therefore run more than one replica, which a per-process map makes
//     silently broken (a handle works on one pod and 401s on the next);
//   • revocation must be immediate and durable — killing the handle is the
//     ONLY way to end an officer session before its non-revocable JWT expires.
//
// Redis would also serve, and was deliberately not used: the dependency was
// deleted from this repo on 2026-07-19 and REDIS_URL is unset in the committed
// .env.example, so a store built on it could not boot from the template.
// ══════════════════════════════════════════════════════════════════

import { asJsonb, sql } from '@usrp/shared-database';
import { aesGcmDecrypt, aesGcmEncrypt } from '@usrp/shared-security';
import { AGENCIES, type Agency } from '@usrp/shared-types';
import { SessionStoreError } from '../../domain/errors.js';
import type { EdgeSession, SessionEndedReason } from '../../domain/session.js';
import { hashHandle } from '../../domain/handle.js';
import type { EdgeSessionStore, SessionLookup } from '../../ports/session-store.js';

const EDGE_ROLE = 'usrp_edge_session_writer';

interface SessionRow {
  readonly kind: string;
  readonly agency: string | null;
  readonly roles: unknown;
  readonly subject_id: string | null;
  readonly credential_ciphertext: string;
  readonly credential_expires_at: Date;
  readonly csrf_token: string;
  readonly idle_expires_at: Date;
  readonly absolute_expires_at: Date;
  readonly revoked_at: Date | null;
}

export interface PgEdgeSessionStoreOptions {
  /** Keys the stored handle hash. SECRET. */
  readonly handleHmacKey: string;
  /** Encrypts the upstream credential at rest. SECRET. */
  readonly credentialKey: string;
  /** How far a successful touch slides the idle window. */
  readonly idleTtlSeconds: number;
}

export class PgEdgeSessionStore implements EdgeSessionStore {
  readonly #options: PgEdgeSessionStoreOptions;

  constructor(options: PgEdgeSessionStoreOptions) {
    this.#options = options;
  }

  async create(handle: string, session: EdgeSession): Promise<void> {
    const handleHash = hashHandle(handle, this.#options.handleHmacKey);
    const ciphertext = aesGcmEncrypt(this.#options.credentialKey, session.credential);
    const agency = session.kind === 'officer' ? session.agency : null;
    const subjectId = session.kind === 'officer' ? session.subjectId : null;
    const roles = session.kind === 'officer' ? session.roles : [];
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(EDGE_ROLE)}`;
        await tx`
          INSERT INTO public_core.edge_sessions
            (handle_hash, kind, agency, roles, subject_id, credential_ciphertext,
             credential_expires_at, csrf_token, idle_expires_at, absolute_expires_at)
          VALUES (${handleHash}, ${session.kind}, ${agency}::public_core.agency,
                  ${tx.json(asJsonb([...roles]))}, ${subjectId}, ${ciphertext},
                  ${session.credentialExpiresAt.toISOString()}, ${session.csrfToken},
                  ${session.idleExpiresAt.toISOString()},
                  ${session.absoluteExpiresAt.toISOString()})
        `;
      });
    } catch (cause) {
      throw new SessionStoreError('Could not create the edge session', { cause });
    }
  }

  async touch(handle: string): Promise<SessionLookup> {
    return this.#resolve(handle, true);
  }

  async peek(handle: string): Promise<SessionLookup> {
    return this.#resolve(handle, false);
  }

  async destroy(handle: string): Promise<void> {
    const handleHash = hashHandle(handle, this.#options.handleHmacKey);
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(EDGE_ROLE)}`;
        // DELETE, not a revoked_at stamp: the row holds a live upstream
        // credential, so the strongest thing logout can do is stop holding it.
        // The reason a client needs ('revoked') comes from the absence of the
        // row, not from a tombstone that keeps the ciphertext around.
        await tx`DELETE FROM public_core.edge_sessions WHERE handle_hash = ${handleHash}`;
      });
    } catch (cause) {
      throw new SessionStoreError('Could not destroy the edge session', { cause });
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(EDGE_ROLE)}`;
        // Touches the real table under the real role: a probe that only ran
        // `SELECT 1` would stay green after a grant or policy regression.
        await tx`SELECT 1 FROM public_core.edge_sessions LIMIT 1`;
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a handle, optionally sliding the idle window in the SAME statement
   * so there is no read-then-write race. The absolute ceiling is never touched.
   */
  async #resolve(handle: string, slide: boolean): Promise<SessionLookup> {
    const handleHash = hashHandle(handle, this.#options.handleHmacKey);
    const idleSeconds = this.#options.idleTtlSeconds;
    let row: SessionRow | undefined;
    let expired: { readonly reason: SessionEndedReason } | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${sql(EDGE_ROLE)}`;
        const live = slide
          ? await tx<SessionRow[]>`
              UPDATE public_core.edge_sessions
              SET idle_expires_at = LEAST(
                    now() + make_interval(secs => ${idleSeconds}::double precision),
                    absolute_expires_at),
                  last_seen_at = now()
              WHERE handle_hash = ${handleHash}
                AND revoked_at IS NULL
                AND idle_expires_at > now()
                AND absolute_expires_at > now()
              RETURNING kind, agency, roles, subject_id, credential_ciphertext,
                        credential_expires_at, csrf_token, idle_expires_at,
                        absolute_expires_at, revoked_at
            `
          : await tx<SessionRow[]>`
              SELECT kind, agency, roles, subject_id, credential_ciphertext,
                     credential_expires_at, csrf_token, idle_expires_at,
                     absolute_expires_at, revoked_at
              FROM public_core.edge_sessions
              WHERE handle_hash = ${handleHash}
                AND revoked_at IS NULL
                AND idle_expires_at > now()
                AND absolute_expires_at > now()
            `;
        const found = live[0];
        if (found !== undefined) {
          row = found;
          return;
        }
        // Nothing live. Read the row WITHOUT the liveness predicates to learn
        // WHY, so the UI can say the right thing instead of one generic
        // "signed out" for three materially different events.
        const dead = await tx<
          {
            readonly revoked_at: Date | null;
            readonly idle_expires_at: Date;
            readonly absolute_expires_at: Date;
          }[]
        >`
          SELECT revoked_at, idle_expires_at, absolute_expires_at
          FROM public_core.edge_sessions
          WHERE handle_hash = ${handleHash}
        `;
        const deadRow = dead[0];
        if (deadRow === undefined) return;
        const now = Date.now();
        if (deadRow.revoked_at !== null) expired = { reason: 'revoked' };
        else if (deadRow.absolute_expires_at.getTime() <= now) expired = { reason: 'absolute' };
        else expired = { reason: 'idle' };
      });
    } catch (cause) {
      throw new SessionStoreError('Could not read the edge session', { cause });
    }

    if (row !== undefined) return { kind: 'LIVE', session: this.#toSession(row) };
    if (expired !== undefined) return { kind: 'ENDED', reason: expired.reason };
    return { kind: 'NONE' };
  }

  #toSession(row: SessionRow): EdgeSession {
    const credential = aesGcmDecrypt(this.#options.credentialKey, row.credential_ciphertext);
    if (row.kind === 'officer') {
      const agency = row.agency;
      if (agency === null || !isAgency(agency) || row.subject_id === null) {
        // The 0019 CHECK constraint makes this unreachable; a store that
        // disagrees with its own schema is corruption, not a client error.
        throw new SessionStoreError('Officer session row is missing its agency or subject');
      }
      return {
        kind: 'officer',
        credential,
        agency,
        roles: toRoles(row.roles),
        subjectId: row.subject_id,
        credentialExpiresAt: row.credential_expires_at,
        idleExpiresAt: row.idle_expires_at,
        absoluteExpiresAt: row.absolute_expires_at,
        csrfToken: row.csrf_token,
      };
    }
    return {
      kind: 'applicant',
      credential,
      credentialExpiresAt: row.credential_expires_at,
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      csrfToken: row.csrf_token,
    };
  }
}

function isAgency(value: string): value is Agency {
  return (AGENCIES as readonly string[]).includes(value);
}

function toRoles(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
