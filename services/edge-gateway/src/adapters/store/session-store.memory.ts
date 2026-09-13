// ══════════════════════════════════════════════════════════════════
// edge-gateway — EdgeSessionStore adapter (in-memory)
//
// FOR PROOFS AND SINGLE-PROCESS LOCAL RUNS ONLY, and it says so out loud when
// constructed. It exists so the selfcheck can drive the edge's cookie, CSRF
// and credential-isolation behaviour without a database, not as a production
// alternative: a per-process map means a handle minted on one replica 401s on
// the next, and a restart signs out every officer mid-shift.
//
// It stores the same KEYED HASH of the handle as the Postgres adapter rather
// than the handle itself — the two must agree about what a stored session
// looks like, or the proof stops proving anything about production.
// ══════════════════════════════════════════════════════════════════

import { SessionStoreError } from '../../domain/errors.js';
import type { EdgeSession, SessionEndedReason } from '../../domain/session.js';
import { hashHandle } from '../../domain/handle.js';
import type { EdgeSessionStore, SessionLookup } from '../../ports/session-store.js';

export interface InMemoryEdgeSessionStoreOptions {
  readonly handleHmacKey: string;
  readonly idleTtlSeconds: number;
}

interface Entry {
  session: EdgeSession;
  revokedAt: Date | null;
}

export class InMemoryEdgeSessionStore implements EdgeSessionStore {
  readonly #entries = new Map<string, Entry>();
  readonly #options: InMemoryEdgeSessionStoreOptions;

  constructor(options: InMemoryEdgeSessionStoreOptions) {
    this.#options = options;
    console.warn(
      JSON.stringify({
        msg: 'edge_session_store_in_memory',
        detail:
          'The edge session store is IN-MEMORY: sessions die on restart and are not shared ' +
          'between replicas. Proofs and single-process local runs only.',
      }),
    );
  }

  create(handle: string, session: EdgeSession): Promise<void> {
    this.#entries.set(this.#key(handle), { session, revokedAt: null });
    return Promise.resolve();
  }

  touch(handle: string): Promise<SessionLookup> {
    return Promise.resolve(this.#resolve(handle, true));
  }

  peek(handle: string): Promise<SessionLookup> {
    return Promise.resolve(this.#resolve(handle, false));
  }

  destroy(handle: string): Promise<void> {
    this.#entries.delete(this.#key(handle));
    return Promise.resolve();
  }

  healthy(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** Test seam: end a session the way an administrator would. */
  revoke(handle: string): void {
    const entry = this.#entries.get(this.#key(handle));
    if (entry === undefined) throw new SessionStoreError('No such session to revoke');
    entry.revokedAt = new Date();
  }

  #key(handle: string): string {
    return hashHandle(handle, this.#options.handleHmacKey);
  }

  #resolve(handle: string, slide: boolean): SessionLookup {
    const entry = this.#entries.get(this.#key(handle));
    if (entry === undefined) return { kind: 'NONE' };
    const now = Date.now();
    let reason: SessionEndedReason | undefined;
    if (entry.revokedAt !== null) reason = 'revoked';
    else if (entry.session.absoluteExpiresAt.getTime() <= now) reason = 'absolute';
    else if (entry.session.idleExpiresAt.getTime() <= now) reason = 'idle';
    if (reason !== undefined) return { kind: 'ENDED', reason };

    if (slide) {
      const slid = new Date(
        Math.min(now + this.#options.idleTtlSeconds * 1000, entry.session.absoluteExpiresAt.getTime()),
      );
      // Branch on the discriminant: spreading a union and assigning it back is
      // not sound, because the spread result is a merged object rather than a
      // member of the union.
      entry.session =
        entry.session.kind === 'officer'
          ? { ...entry.session, idleExpiresAt: slid }
          : { ...entry.session, idleExpiresAt: slid };
    }
    return { kind: 'LIVE', session: entry.session };
  }
}
