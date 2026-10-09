// BUILD-001 populated-database upgrade proof.
//
// Creates a disposable real PostgreSQL database, applies the exact pre-BUILD-001
// Drizzle migrations, inserts representative legacy campaign/session rows, then
// applies the exact 0002/0003 SQL files. It verifies generated legacy public
// codes, known/unknown district backfill, legacy status/count/date preservation,
// and nullable v2 boundary columns. This is deliberately not a source-text or
// PGlite rehearsal: CREATE DATABASE and every migration statement run on the
// configured live PostgreSQL server.
//
// Requires ADMIN_DATABASE_URL (default local usrp_admin) with CREATEDB and
// permission to DROP the uniquely named disposable database.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ADMIN_URL = process.env['ADMIN_DATABASE_URL']
  ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { max: 1, prepare: false, onnotice: () => {} });
const databaseName = `usrp_build001_upgrade_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const fixtureWithVenues = randomUUID();
const fixtureWithoutVenues = randomUUID();
const MIGRATIONS = [
  '0000_grey_the_stranger.sql',
  '0001_align_edge_session_kind.sql',
  '0002_campaign_control_plane.sql',
  '0003_build_001_boundary_columns.sql',
] as const;

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function migrationPath(name: (typeof MIGRATIONS)[number]): string {
  return resolve(REPO_ROOT, 'packages/shared-database/src/migrations', name);
}

async function main(): Promise<void> {
  let databaseCreated = false;
  let upgrade: ReturnType<typeof postgres> | undefined;
  try {
    const server = await admin<{ version: string; current_user: string }[]>`
      SELECT current_setting('server_version') AS version, current_user
    `;
    console.log(`\nBUILD-001 populated-upgrade proof on PostgreSQL ${server[0]?.version ?? 'unknown'} as ${server[0]?.current_user ?? 'unknown'}`);

    // databaseName is generated from a fixed safe alphabet, not user input.
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const databaseUrl = new URL(ADMIN_URL);
    databaseUrl.pathname = `/${databaseName}`;
    upgrade = postgres(databaseUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });

    for (const name of MIGRATIONS.slice(0, 2)) {
      await upgrade.unsafe(readFileSync(migrationPath(name), 'utf8'));
    }
    const baselineColumns = await upgrade<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public_core'
        AND table_name = 'recruitment_campaigns'
        AND column_name IN ('public_code', 'target_districts')
    `;
    check('temporary database is at the populated pre-0002 campaign schema', baselineColumns.length === 0);

    const registrationOpened = '2026-03-01T08:00:00.000Z';
    const registrationClosed = '2026-03-31T17:00:00.000Z';
    const publicationTime = '2026-02-20T12:00:00.000Z';
    await upgrade`
      INSERT INTO public_core.recruitment_campaigns
        (id, campaign_label, agency, status, target_categories,
         registration_opens_at, registration_closes_at,
         examination_start_date, examination_end_date, examination_reporting_hour,
         allows_walk_in, published_at)
      VALUES
        (${fixtureWithVenues}::uuid, 'BUILD-001 populated upgrade with venues', 'RDF',
         'REGISTRATION_OPEN', '["GENERAL_ENLISTMENT"]',
         ${registrationOpened}::timestamptz, ${registrationClosed}::timestamptz,
         '2026-04-01', '2026-04-15', 8, false, ${publicationTime}::timestamptz),
        (${fixtureWithoutVenues}::uuid, 'BUILD-001 populated upgrade without venues', 'RNP',
         'EXAMINATION_ACTIVE', '["CADET_OFFICER"]',
         ${registrationOpened}::timestamptz, ${registrationClosed}::timestamptz,
         '2026-04-01', '2026-04-15', 9, false, ${publicationTime}::timestamptz)
    `;
    await upgrade`
      INSERT INTO public_core.campaign_venue_assignments
        (campaign_id, district, province, venue_name, exam_date,
         reporting_time_hour, capacity_limit, registered_count, is_active)
      VALUES
        (${fixtureWithVenues}::uuid, 'GASABO', 'KIGALI_CITY', 'Legacy GASABO venue', '2026-04-02', 8, 12, 3, true),
        (${fixtureWithVenues}::uuid, 'KICUKIRO', 'KIGALI_CITY', 'Legacy KICUKIRO venue', '2026-04-03', 9, 15, 5, true)
    `;

    const baseline = await upgrade<{ campaigns: number; sessions: number; reserved: number }[]>`
      SELECT
        (SELECT count(*)::int FROM public_core.recruitment_campaigns) AS campaigns,
        (SELECT count(*)::int FROM public_core.campaign_venue_assignments) AS sessions,
        (SELECT sum(registered_count)::int FROM public_core.campaign_venue_assignments) AS reserved
    `;
    check('baseline contains two populated campaigns and two legacy venue rows',
      baseline[0]?.campaigns === 2 && baseline[0]?.sessions === 2 && baseline[0]?.reserved === 8);

    for (const name of MIGRATIONS.slice(2)) {
      await upgrade.unsafe(readFileSync(migrationPath(name), 'utf8'));
    }

    const migrated = await upgrade<{
      id: string;
      campaign_label: string;
      status: string;
      public_code: string;
      target_districts: unknown;
      published_at: Date | null;
      opens_at: Date;
      closes_at: Date;
    }[]>`
      SELECT id::text AS id, campaign_label, status::text AS status, public_code,
             target_districts, published_at,
             registration_opens_at AS opens_at, registration_closes_at AS closes_at
      FROM public_core.recruitment_campaigns
      ORDER BY campaign_label
    `;
    const withVenues = migrated.find((row) => row.id === fixtureWithVenues);
    const withoutVenues = migrated.find((row) => row.id === fixtureWithoutVenues);
    check('legacy public codes are deterministic UUID-derived LEGACY codes',
      withVenues?.public_code === `LEGACY-${fixtureWithVenues.replaceAll('-', '').toUpperCase()}` &&
      withoutVenues?.public_code === `LEGACY-${fixtureWithoutVenues.replaceAll('-', '').toUpperCase()}`);
    check('known target districts backfill in sorted order; unknown target set stays NULL',
      JSON.stringify(withVenues?.target_districts) === '["GASABO","KICUKIRO"]' &&
      withoutVenues?.target_districts === null);
    check('existing campaign statuses, labels, timestamps, and publication timestamps survive the upgrade',
      withVenues?.status === 'REGISTRATION_OPEN' && withoutVenues?.status === 'EXAMINATION_ACTIVE' &&
      withVenues.campaign_label === 'BUILD-001 populated upgrade with venues' &&
      withoutVenues.campaign_label === 'BUILD-001 populated upgrade without venues' &&
      withVenues.opens_at.toISOString() === registrationOpened &&
      withVenues.closes_at.toISOString() === registrationClosed &&
      withVenues.published_at?.toISOString() === publicationTime &&
      withoutVenues.published_at?.toISOString() === publicationTime);

    const retainedSessions = await upgrade<{ count: number; reserved: number }[]>`
      SELECT count(*)::int AS count, sum(registered_count)::int AS reserved
      FROM public_core.campaign_venue_assignments
      WHERE campaign_id = ${fixtureWithVenues}::uuid
    `;
    check('existing venue/session rows and registered seat counts survive migration',
      retainedSessions[0]?.count === 2 && retainedSessions[0]?.reserved === 8);

    const boundaryColumns = await upgrade<{
      canonical_policy_json: string | null;
      capacity_decision_code: string | null;
      policy_versions: number;
    }[]>`
      SELECT
        (SELECT canonical_policy_json FROM public_core.campaign_policy_versions LIMIT 1) AS canonical_policy_json,
        (SELECT capacity_decision_code FROM public_core.campaign_venue_assignments
          WHERE campaign_id = ${fixtureWithVenues}::uuid LIMIT 1) AS capacity_decision_code,
        (SELECT count(*)::int FROM public_core.campaign_policy_versions) AS policy_versions
    `;
    check('later BUILD-001 boundary columns are nullable and do not fabricate legacy policy decisions',
      boundaryColumns[0]?.canonical_policy_json === null &&
      boundaryColumns[0]?.capacity_decision_code === null &&
      boundaryColumns[0]?.policy_versions === 0);

    const publicCodeConstraint = await upgrade<{ not_null: boolean; unique_index: boolean }[]>`
      SELECT
        (SELECT is_nullable = 'NO' FROM information_schema.columns
          WHERE table_schema = 'public_core' AND table_name = 'recruitment_campaigns' AND column_name = 'public_code') AS not_null,
        to_regclass('public_core.idx_pc_campaign_public_code') IS NOT NULL AS unique_index
    `;
    check('public-code backfill leaves the final non-null column and unique lookup index valid',
      publicCodeConstraint[0]?.not_null === true && publicCodeConstraint[0]?.unique_index === true);
  } catch (error) {
    fail += 1;
    console.error('  ✗ populated upgrade proof crashed', error instanceof Error ? error.message : String(error));
  } finally {
    if (upgrade !== undefined) await upgrade.end({ timeout: 5 }).catch(() => {});
    if (databaseCreated) {
      try {
        await admin.unsafe(`DROP DATABASE "${databaseName}"`);
      } catch (error) {
        fail += 1;
        console.error('  ✗ failed to drop disposable upgrade database', error instanceof Error ? error.message : String(error));
      }
    }
    await admin.end({ timeout: 5 });
  }

  console.log(`\nBUILD-001 POPULATED UPGRADE: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error('BUILD-001 populated-upgrade proof crashed:', error);
  process.exitCode = 1;
});
