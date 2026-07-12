// ══════════════════════════════════════════════════════════════════
// iam-service — Dev officer-account seed (dev-only, idempotent)
//
// Seeds one officer per agency so the officer console (and manual login smoke
// tests) have real credentials to drive. NOT for production — real officers are
// provisioned through a proper IdP/workflow (a deferred follow-on). Each row is
// inserted AS usrp_iam_service (the only role permitted on the credential store)
// with a scrypt password digest computed here in Node — SQL has no scrypt
// primitive, which is precisely why seeding lives in TS.
//
//   pnpm --filter @usrp/iam-service exec tsx scripts/seed-dev-officers.ts
//   (or `pnpm --filter @usrp/iam-service seed:dev`)
//
// Idempotent: ON CONFLICT (login_handle) DO NOTHING. Re-running is a no-op.
// ══════════════════════════════════════════════════════════════════

import { sql } from '@usrp/shared-database';
import { hashPassword } from '@usrp/shared-security';
import type { Agency } from '@usrp/shared-types';

/** The dev password for every seeded officer. DEV ONLY — never a real secret. */
const DEV_PASSWORD = 'DevOfficer#2026';

interface DevOfficer {
  readonly officerId: string; // fixed UUID → stable across runs
  readonly loginHandle: string;
  readonly agency: Agency;
  readonly roles: readonly string[];
}

const DEV_OFFICERS: readonly DevOfficer[] = [
  { officerId: '11111111-1111-4111-8111-111111111111', loginHandle: 'rdf.officer', agency: 'RDF', roles: ['reviewer'] },
  { officerId: '22222222-2222-4222-8222-222222222222', loginHandle: 'rnp.officer', agency: 'RNP', roles: ['reviewer'] },
  { officerId: '33333333-3333-4333-8333-333333333333', loginHandle: 'rcs.officer', agency: 'RCS', roles: ['reviewer'] },
];

async function main(): Promise<void> {
  let seeded = 0;
  for (const officer of DEV_OFFICERS) {
    const credential = hashPassword(DEV_PASSWORD);
    const inserted = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE ${sql('usrp_iam_service')}`;
      const rows = await tx<{ officer_id: string }[]>`
        INSERT INTO public_core.officer_accounts
          (officer_id, login_handle, credential, agency, roles)
        VALUES (
          ${officer.officerId}, ${officer.loginHandle}, ${credential},
          ${officer.agency}, ${sql.array(officer.roles as string[])}
        )
        ON CONFLICT (login_handle) DO NOTHING
        RETURNING officer_id
      `;
      return rows.length > 0;
    });
    seeded += inserted ? 1 : 0;
    console.log(
      JSON.stringify({
        msg: inserted ? 'officer_seeded' : 'officer_exists',
        loginHandle: officer.loginHandle,
        agency: officer.agency,
      }),
    );
  }
  console.log(
    JSON.stringify({ msg: 'seed_complete', inserted: seeded, total: DEV_OFFICERS.length, devPassword: DEV_PASSWORD }),
  );
  await sql.end({ timeout: 5 });
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: 'seed_failed' }), err);
  process.exit(1);
});
