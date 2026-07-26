// ══════════════════════════════════════════════════════════════════
// identity-service — Retention sweep CLI (ADR-019, owner D7)
//
// DRY-RUN BY DEFAULT: prints what the policy would sweep and exits.
// Destruction requires the explicit flag:
//
//   pnpm --filter @usrp/identity-service exec tsx scripts/retention-sweep.ts            # report only
//   pnpm --filter @usrp/identity-service exec tsx scripts/retention-sweep.ts --execute  # perform
//
// Cron-able (a scheduler runs it with --execute on the owner's cadence).
// With KAFKA_BROKERS set the tombstone audits go to the real bus; without
// it they are local-only — logged loudly, dev/tier1 only. The sweep
// erases through the SAME gated ErasureRepository as citizen demands, so
// it can never tombstone an active or enlisted citizen.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { InMemoryEventBus, KafkaEventBus, type EventBus } from '@usrp/shared-events';
import { loadKafkaConfig } from '@usrp/shared-config';
import { PgErasureRepository } from '../src/adapters/erasure.pg-repository.js';
import { PgRetentionRepository } from '../src/adapters/retention.pg-repository.js';
import { RetentionSweepService } from '../src/application/retention-sweep.service.js';
import {
  RETENTION_NEGATIVE_TERMINAL_MONTHS,
  RETENTION_NEVER_APPLIED_MONTHS,
  RETENTION_PURGE_GRACE_DAYS,
} from '../src/config.js';

function createEventBus(): EventBus {
  if (process.env['KAFKA_BROKERS']) {
    const kafka = loadKafkaConfig('retention-sweep');
    return new KafkaEventBus({ brokers: kafka.brokers, clientId: kafka.clientId, ssl: kafka.ssl });
  }
  console.warn(
    JSON.stringify({
      msg: 'kafka_not_configured',
      detail: 'KAFKA_BROKERS unset — tombstone audits are NOT durably published. Dev/tier1 only.',
    }),
  );
  return new InMemoryEventBus();
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const bus = createEventBus();
  await bus.connect();

  const sweep = new RetentionSweepService({
    retention: new PgRetentionRepository(),
    erasure: new PgErasureRepository(),
    eventBus: bus,
    policy: {
      neverAppliedMonths: RETENTION_NEVER_APPLIED_MONTHS,
      negativeTerminalMonths: RETENTION_NEGATIVE_TERMINAL_MONTHS,
      purgeGraceDays: RETENTION_PURGE_GRACE_DAYS,
    },
  });

  if (execute) {
    const result = await sweep.execute();
    console.log(JSON.stringify({ msg: 'retention_sweep_executed', ...result }, null, 2));
  } else {
    const report = await sweep.report();
    console.log(
      JSON.stringify(
        { msg: 'retention_sweep_dry_run', note: 'nothing was changed — pass --execute to perform', ...report },
        null,
        2,
      ),
    );
  }

  await bus.disconnect();
  await sql.end({ timeout: 5 });
}

main().catch(async (err: unknown) => {
  console.error(JSON.stringify({ msg: 'retention_sweep_failed' }), err);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
