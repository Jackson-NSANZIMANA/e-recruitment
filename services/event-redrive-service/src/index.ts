// ══════════════════════════════════════════════════════════════════
// @usrp/event-redrive-service — Public API
//
// The composition root and the re-exports the proofs and the sandbox use.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { resolveRedrivePolicy, type RedrivePolicy } from '@usrp/shared-events';
import { RedriveDeadLettersService } from './application/redrive-dead-letters.service.js';
import { PgRedriveLedger } from './adapters/redrive-ledger.pg.js';
import { KafkaDeadLetterSource, KafkaRawRepublisher } from './adapters/kafka-dead-letter-source.js';

export interface RedriveCompositionOptions {
  readonly kafka: { readonly brokers: readonly string[]; readonly clientId: string; readonly ssl?: boolean };
  readonly policy?: Partial<RedrivePolicy>;
  readonly now?: () => number;
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface RedriveComposition {
  readonly service: RedriveDeadLettersService;
  readonly republisher: KafkaRawRepublisher;
  readonly readiness: () => Promise<boolean>;
  readonly close: () => Promise<void>;
}

export function createRedriveService(options: RedriveCompositionOptions): RedriveComposition {
  const policy = resolveRedrivePolicy(options.policy ?? {});
  const log =
    options.log ??
    ((line: Record<string, unknown>): void => {
      process.stdout.write(`${JSON.stringify(line)}\n`);
    });
  const republisher = new KafkaRawRepublisher(options.kafka);
  const service = new RedriveDeadLettersService({
    ledger: new PgRedriveLedger(),
    source: new KafkaDeadLetterSource(options.kafka),
    republisher,
    policy,
    now: options.now ?? ((): number => Date.now()),
    log,
  });

  return {
    service,
    republisher,
    readiness: async (): Promise<boolean> => {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    close: async (): Promise<void> => {
      await republisher.disconnect();
      await sql.end({ timeout: 5 });
    },
  };
}

export { RedriveDeadLettersService } from './application/redrive-dead-letters.service.js';
export { PgRedriveLedger } from './adapters/redrive-ledger.pg.js';
export { KafkaDeadLetterSource, KafkaRawRepublisher } from './adapters/kafka-dead-letter-source.js';
export { startRedriveWorker, type WorkerHandle, type WorkerOptions } from './worker.js';
