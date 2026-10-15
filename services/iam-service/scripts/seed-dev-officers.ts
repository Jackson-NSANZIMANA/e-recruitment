// ══════════════════════════════════════════════════════════════════
// iam-service — Dev officer-account seed (dev-only, idempotent)
//
// Seeds one officer per agency so the officer console (and manual login smoke
// tests) have real credentials to drive. NOT for production — real officers are
// provisioned through a proper IdP/workflow (a deferred follow-on). Officer rows
// are inserted by a direct privileged local operator connection because
// usrp_iam_service is SELECT-only on the credential store. The scrypt password
// digest is computed here in Node; SQL has no scrypt primitive.
//
//   DEV_SEED_DATABASE_URL='postgresql://usrp_admin:...@localhost:5432/usrp_db' pnpm --filter @usrp/iam-service seed:dev
// Supply the privileged local operator URL; the shared usrp_app login is denied.
//
// Idempotent: ON CONFLICT (login_handle) refreshes ROLES only (the posts are
// the part that evolves); the credential is never overwritten. Safe to re-run.
// ══════════════════════════════════════════════════════════════════

import postgres from 'postgres';
import { hashPassword } from '@usrp/shared-security';
import type { Agency } from '@usrp/shared-types';

/** The dev password for every seeded officer. DEV ONLY — never a real secret. */
const DEV_PASSWORD = 'DevOfficer#2026';

/** The dev client secret for the seeded service account. DEV ONLY. */
const DEV_CLIENT_SECRET = 'DevService#2026';

/** Machine clients (ADR-016): the tier1 pipeline + the applicant portal
 * backend (identity-service's me-routes, ADR-018). Fixed UUIDs → stable. */
const DEV_SERVICE_CLIENTS = [
  {
    serviceId: '44444444-4444-4444-8444-444444444444',
    clientId: 'dev.pipeline',
    description: 'Dev tier1 pipeline client (seed-dev-officers)',
  },
  {
    serviceId: '55555555-5555-4555-8555-555555555555',
    clientId: 'dev.identity-portal',
    description: 'Dev applicant-portal backend client (identity-service, ADR-018)',
  },
] as const;

interface DevOfficer {
  readonly officerId: string; // fixed UUID → stable across runs
  readonly loginHandle: string;
  readonly agency: Agency;
  readonly roles: readonly string[];
}

// DEV ONLY. Two posts per agency so the four-eyes rule can be exercised end to
// end: the `.officer` runs the examination day and the medical verdict; the
// `.director` is the only post that may sign the final decision and accept
// (BUILD-004 §D). Neither can do the other's job, and no dev account is
// `agency_admin` — campaign authoring uses the separately provisioned admin.
const OFFICER_ROLES = [
  'reviewer',
  'screening_officer',
  'field_supervisor',
  'medical_officer',
  'adjudicator',
] as const;
const DIRECTOR_ROLES = ['decision_authority'] as const;

const DEV_OFFICERS: readonly DevOfficer[] = [
  { officerId: '11111111-1111-4111-8111-111111111111', loginHandle: 'rdf.officer', agency: 'RDF', roles: OFFICER_ROLES },
  { officerId: '22222222-2222-4222-8222-222222222222', loginHandle: 'rnp.officer', agency: 'RNP', roles: OFFICER_ROLES },
  { officerId: '33333333-3333-4333-8333-333333333333', loginHandle: 'rcs.officer', agency: 'RCS', roles: OFFICER_ROLES },
  { officerId: '11111111-1111-4111-8111-1111111111d1', loginHandle: 'rdf.director', agency: 'RDF', roles: DIRECTOR_ROLES },
  { officerId: '22222222-2222-4222-8222-2222222222d2', loginHandle: 'rnp.director', agency: 'RNP', roles: DIRECTOR_ROLES },
  { officerId: '33333333-3333-4333-8333-3333333333d3', loginHandle: 'rcs.director', agency: 'RCS', roles: DIRECTOR_ROLES },
];

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed fixed development officer credentials when NODE_ENV=production.');
  }
  const databaseUrl = process.env['DEV_SEED_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('Set DEV_SEED_DATABASE_URL (or DATABASE_URL) to a privileged local development database connection.');
  }

  const database = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const [principal] = await database<{
      readonly session_user: string;
      readonly current_user: string;
      readonly officer_insert: boolean;
      readonly can_bypass_rls: boolean;
      readonly iam_role_assumable: boolean;
    }[]>`
      SELECT
        session_user::text AS session_user,
        current_user::text AS current_user,
        has_table_privilege(current_user, 'public_core.officer_accounts', 'INSERT') AS officer_insert,
        (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS can_bypass_rls,
        (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)
          OR pg_has_role(session_user, 'usrp_iam_service', 'MEMBER') AS iam_role_assumable
    `;
    if (!principal || principal.session_user === 'usrp_app' || principal.current_user === 'usrp_app' ||
        principal.session_user !== principal.current_user || !principal.officer_insert ||
        !principal.can_bypass_rls || !principal.iam_role_assumable) {
      throw new Error(
        `Officer seeding requires a direct operator connection with officer-account INSERT and BYPASSRLS (session_user=${principal?.session_user ?? 'unknown'}, ` +
        `current_user=${principal?.current_user ?? 'unknown'}); usrp_app is intentionally read-only for officer accounts. ` +
        'Set DEV_SEED_DATABASE_URL to the local database administrator URL. The URL is never logged.',
      );
    }

    let seeded = 0;
    for (const officer of DEV_OFFICERS) {
      const credential = hashPassword(DEV_PASSWORD);
      const inserted = await database.begin(async (tx) => {
        // The privileged development operator inserts under its authenticated
        // session; usrp_iam_service is intentionally SELECT-only for this table.
        const rows = await tx<{ inserted: boolean }[]>`
          INSERT INTO public_core.officer_accounts
            (officer_id, login_handle, credential, agency, roles)
          VALUES (
            ${officer.officerId}, ${officer.loginHandle}, ${credential},
            ${officer.agency}, ${tx.array(officer.roles as string[])}
          )
          ON CONFLICT (login_handle) DO UPDATE SET roles = EXCLUDED.roles
          RETURNING (xmax = 0) AS inserted
        `;
        // xmax = 0 → a fresh row; otherwise an existing post had its roles refreshed.
        return rows[0]?.inserted === true;
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
    // The dev service clients (same idempotent shape as the officers).
    for (const client of DEV_SERVICE_CLIENTS) {
      const serviceCredential = hashPassword(DEV_CLIENT_SECRET);
      const clientInserted = await database.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_iam_service`;
        const rows = await tx<{ service_id: string }[]>`
          INSERT INTO public_core.service_accounts (service_id, client_id, credential, description)
          VALUES (${client.serviceId}, ${client.clientId}, ${serviceCredential}, ${client.description})
          ON CONFLICT (client_id) DO NOTHING
          RETURNING service_id
        `;
        return rows.length > 0;
      });
      console.log(
        JSON.stringify({
          msg: clientInserted ? 'service_client_seeded' : 'service_client_exists',
          clientId: client.clientId,
        }),
      );
    }

    console.log(
      JSON.stringify({ msg: 'seed_complete', inserted: seeded, total: DEV_OFFICERS.length, devPassword: DEV_PASSWORD }),
    );
  } finally {
    await database.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ msg: 'seed_failed', error: message }));
  process.exit(1);
});
