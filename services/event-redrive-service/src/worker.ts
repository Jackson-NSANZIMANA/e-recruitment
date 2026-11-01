// ══════════════════════════════════════════════════════════════════
// event-redrive-service — The tick loop, under a Postgres advisory lock (D2)
//
// SINGLE LEADER BY DATABASE, NOT BY DEPLOYMENT DISCIPLINE. Two copies of this
// service (a bad rollout, a stray `docker run`, a k8s surge) must not both
// re-drive the same letter. `pg_try_advisory_lock` is held for the life of the
// connection and released by the engine if the process dies — no lease table,
// no clock skew, no stale row to clean up. The platform already uses this idiom
// for single-leader work.
//
// A tick that finds no lock simply does not run: the leader is doing it.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import type { RedriveDeadLettersService, RedriveTickResult } from './application/redrive-dead-letters.service.js';

export interface WorkerOptions {
  readonly service: RedriveDeadLettersService;
  readonly tickIntervalMs: number;
  readonly leaderLockKey: number;
  readonly log: (line: Record<string, unknown>) => void;
}

export interface WorkerHandle {
  /** Run exactly one tick (used by the sandbox and by proofs). */
  tickOnce(): Promise<RedriveTickResult | null>;
  stop(): Promise<void>;
}

/** Acquire the leader lock on a dedicated connection; null when another holds it. */
async function tryAcquire(key: number): Promise<boolean> {
  const rows = await sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${key}) AS locked`;
  return rows[0]?.locked === true;
}

async function release(key: number): Promise<void> {
  await sql`SELECT pg_advisory_unlock(${key})`;
}

export async function startRedriveWorker(options: WorkerOptions): Promise<WorkerHandle> {
  const leader = await tryAcquire(options.leaderLockKey);
  options.log({
    msg: leader ? 'event_redrive_leader_acquired' : 'event_redrive_standby',
    lockKey: options.leaderLockKey,
  });

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let running = false;

  const tickOnce = async (): Promise<RedriveTickResult | null> => {
    if (!leader || stopped || running) return null;
    running = true;
    try {
      const counts = await options.service.tick();
      if (counts.claimed > 0) {
        options.log({ msg: 'event_redrive_tick', ...counts });
      }
      return counts;
    } catch (error) {
      // A tick must never kill the process: the letters stay in the ledger and
      // the next tick retries. Anything louder belongs to S11a alerting.
      options.log({
        msg: 'event_redrive_tick_failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    } finally {
      running = false;
    }
  };

  if (leader) {
    timer = setInterval(() => {
      void tickOnce();
    }, options.tickIntervalMs);
    // The loop must not hold the event loop open on shutdown.
    timer.unref();
  }

  return {
    tickOnce,
    stop: async (): Promise<void> => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      if (leader) await release(options.leaderLockKey);
      options.log({ msg: 'event_redrive_worker_stopped' });
    },
  };
}
