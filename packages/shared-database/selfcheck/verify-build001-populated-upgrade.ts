// BUILD-001 populated-database upgrade proof.
//
// Creates a disposable real PostgreSQL database, applies the pre-BUILD-001
// Drizzle migrations, inserts representative legacy campaign/session rows,
// applies every forward migration, then replays every RLS bootstrap SQL file
// twice against those same populated rows. It verifies deterministic legacy
// public codes, district backfill, data preservation, repeated-bootstrap
// privileges and denied writes, plus the retained system outbox metadata lane.
// This is not a source-text or PGlite rehearsal: CREATE DATABASE and every migration statement run on the
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
  '0004_build001_completion_and_capacity_constraints.sql',
] as const;
const RLS_BOOTSTRAP = [...readFileSync(resolve(REPO_ROOT, 'scripts/bootstrap-db.sh'), 'utf8')
  .matchAll(/apply_sql "\$\{RLS_DIR\}\/([^"]+)"/g)]
  .map((match) => match[1] ?? '')
  .filter((name) => name.length > 0);

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

async function expectPermissionDenied(label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
    check(label, false, 'write unexpectedly succeeded');
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { readonly code: unknown }).code)
      : 'UNKNOWN';
    check(label, code === '42501', `expected SQLSTATE 42501, got ${code}`);
  }
}

function migrationPath(name: (typeof MIGRATIONS)[number]): string {
  return resolve(REPO_ROOT, 'packages/shared-database/src/migrations', name);
}

function rlsPath(name: string): string {
  return resolve(REPO_ROOT, 'packages/shared-database/src/rls', name);
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

    check('full RLS bootstrap manifest is derived from bootstrap-db.sh without duplicates',
      RLS_BOOTSTRAP.length >= 27 && new Set(RLS_BOOTSTRAP).size === RLS_BOOTSTRAP.length &&
      RLS_BOOTSTRAP.includes('0026_campaign_control_plane.sql') &&
      RLS_BOOTSTRAP.includes('0027_campaign_command_functions.sql'));
    const relayProbeEventId = randomUUID();
    let relayProbeCreated = false;
    for (let replay = 1; replay <= 2; replay += 1) {
      console.log(`\nApplying full RLS bootstrap replay ${replay}/2 (${RLS_BOOTSTRAP.length} SQL files)`);
      for (const file of RLS_BOOTSTRAP) {
        await upgrade.unsafe(readFileSync(rlsPath(file), 'utf8'));
      }

      if (!relayProbeCreated) {
        await upgrade`
          INSERT INTO public_core.event_outbox (event_id, event_type, producer, payload)
          VALUES (
            ${relayProbeEventId}::uuid, 'BUILD001_RELAY_PROBE', 'application-service',
            '{"eventType":"BUILD001_RELAY_PROBE","entityType":"TEST"}'::jsonb
          )`;
        relayProbeCreated = true;
      }

      const afterReplay = await upgrade<{
        iam_officer_insert: boolean;
        iam_officer_update: boolean;
        app_officer_insert: boolean;
        app_officer_update: boolean;
        officer_campaign_insert: boolean;
        officer_session_insert: boolean;
        system_seat_update: boolean;
        system_payload_update: boolean;
        system_relay_update: boolean;
        officer_command_execute: boolean;
        provisioner_login: boolean;
        provisioner_superuser: boolean;
        provisioner_createdb: boolean;
        provisioner_createrole: boolean;
        provisioner_bypassrls: boolean;
        provisioner_inherit: boolean;
        provisioner_member_app: boolean;
        app_member_provisioner: boolean;
        app_member_provision_owner: boolean;
        provisioner_execute: boolean;
        app_provisioner_execute: boolean;
        lock_owner_login: boolean;
        lock_owner_table_insert: boolean;
        lock_owner_table_update: boolean;
        lock_owner_updated_at_update: boolean;
        lock_owner_status_update: boolean;
        lock_owner_extra_update_columns: number;
        lock_owner_id_update: boolean;
        app_member_lock_owner: boolean;
        lock_function_owner: string | null;
        unsafe_definer_paths: number;
        legacy_campaigns: number;
        legacy_sessions: number;
        legacy_reserved: number;
        legacy_active_status: string | null;
        legacy_exam_status: string | null;
      }[]>`
        SELECT
          (has_table_privilege('usrp_iam_service', 'public_core.officer_accounts', 'INSERT')
            OR has_any_column_privilege('usrp_iam_service', 'public_core.officer_accounts', 'INSERT')) AS iam_officer_insert,
          (has_table_privilege('usrp_iam_service', 'public_core.officer_accounts', 'UPDATE')
            OR has_any_column_privilege('usrp_iam_service', 'public_core.officer_accounts', 'UPDATE')) AS iam_officer_update,
          (has_table_privilege('usrp_app', 'public_core.officer_accounts', 'INSERT')
            OR has_any_column_privilege('usrp_app', 'public_core.officer_accounts', 'INSERT')) AS app_officer_insert,
          (has_table_privilege('usrp_app', 'public_core.officer_accounts', 'UPDATE')
            OR has_any_column_privilege('usrp_app', 'public_core.officer_accounts', 'UPDATE')) AS app_officer_update,
          has_table_privilege('usrp_rdf_officer', 'public_core.recruitment_campaigns', 'INSERT') AS officer_campaign_insert,
          has_table_privilege('usrp_rdf_officer', 'public_core.campaign_venue_assignments', 'INSERT') AS officer_session_insert,
          has_column_privilege('usrp_system_service', 'public_core.campaign_venue_assignments', 'registered_count', 'UPDATE') AS system_seat_update,
          has_column_privilege('usrp_system_service', 'public_core.event_outbox', 'payload', 'UPDATE') AS system_payload_update,
          (has_table_privilege('usrp_system_service', 'public_core.event_outbox', 'UPDATE')
            OR has_any_column_privilege('usrp_system_service', 'public_core.event_outbox', 'UPDATE')) AS system_relay_update,
          has_function_privilege('usrp_rdf_officer', 'public_core.campaign_write_draft(jsonb)', 'EXECUTE') AS officer_command_execute,
          (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_login,
          (SELECT rolsuper FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_superuser,
          (SELECT rolcreatedb FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_createdb,
          (SELECT rolcreaterole FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_createrole,
          (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_bypassrls,
          (SELECT rolinherit FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_inherit,
          pg_has_role('usrp_iam_provisioner', 'usrp_app', 'MEMBER') AS provisioner_member_app,
          pg_has_role('usrp_app', 'usrp_iam_provisioner', 'MEMBER') AS app_member_provisioner,
          pg_has_role('usrp_app', 'usrp_campaign_admin_provision_owner', 'MEMBER') AS app_member_provision_owner,
          has_function_privilege('usrp_iam_provisioner', 'public_core.provision_first_campaign_agency_admin(uuid,text,text,public_core.agency,text,text)', 'EXECUTE') AS provisioner_execute,
          has_function_privilege('usrp_app', 'public_core.provision_first_campaign_agency_admin(uuid,text,text,public_core.agency,text,text)', 'EXECUTE') AS app_provisioner_execute,
          (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'usrp_campaign_application_lock_owner') AS lock_owner_login,
          has_table_privilege('usrp_campaign_application_lock_owner', 'public_core.recruitment_campaigns', 'INSERT') AS lock_owner_table_insert,
          has_table_privilege('usrp_campaign_application_lock_owner', 'public_core.recruitment_campaigns', 'UPDATE') AS lock_owner_table_update,
          has_column_privilege('usrp_campaign_application_lock_owner', 'public_core.recruitment_campaigns', 'updated_at', 'UPDATE') AS lock_owner_updated_at_update,
          has_column_privilege('usrp_campaign_application_lock_owner', 'public_core.recruitment_campaigns', 'status', 'UPDATE') AS lock_owner_status_update,
          (SELECT count(*)::int
            FROM pg_attribute AS column_info
            WHERE column_info.attrelid = 'public_core.recruitment_campaigns'::regclass
              AND column_info.attnum > 0 AND NOT column_info.attisdropped
              AND column_info.attname <> 'updated_at'
              AND has_column_privilege('usrp_campaign_application_lock_owner', 'public_core.recruitment_campaigns', column_info.attname, 'UPDATE')) AS lock_owner_extra_update_columns,
          has_column_privilege('usrp_campaign_application_lock_owner', 'public_core.recruitment_campaigns', 'id', 'UPDATE') AS lock_owner_id_update,
          pg_has_role('usrp_app', 'usrp_campaign_application_lock_owner', 'MEMBER') AS app_member_lock_owner,
          (SELECT owner.rolname FROM pg_proc AS function
            JOIN pg_roles AS owner ON owner.oid = function.proowner
            WHERE function.oid = 'public_core.lock_campaign_for_application_insert(uuid,public_core.agency)'::regprocedure) AS lock_function_owner,
          (SELECT count(*)::int FROM pg_proc AS function
            JOIN pg_roles AS owner ON owner.oid = function.proowner
            WHERE owner.rolname IN ('usrp_campaign_command_owner', 'usrp_campaign_admin_provision_owner', 'usrp_campaign_application_lock_owner')
              AND function.prosecdef
              AND NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(function.proconfig, ARRAY[]::text[])))) AS unsafe_definer_paths,
          (SELECT count(*)::int FROM public_core.recruitment_campaigns
            WHERE id IN (${fixtureWithVenues}::uuid, ${fixtureWithoutVenues}::uuid)) AS legacy_campaigns,
          (SELECT count(*)::int FROM public_core.campaign_venue_assignments
            WHERE campaign_id = ${fixtureWithVenues}::uuid) AS legacy_sessions,
          (SELECT sum(registered_count)::int FROM public_core.campaign_venue_assignments
            WHERE campaign_id = ${fixtureWithVenues}::uuid) AS legacy_reserved,
          (SELECT status::text FROM public_core.recruitment_campaigns WHERE id = ${fixtureWithVenues}::uuid) AS legacy_active_status,
          (SELECT status::text FROM public_core.recruitment_campaigns WHERE id = ${fixtureWithoutVenues}::uuid) AS legacy_exam_status
      `;
      const boundary = afterReplay[0];
      check(`RLS replay ${replay} preserves populated campaigns, sessions, and seat counts`,
        boundary?.legacy_campaigns === 2 && boundary.legacy_sessions === 2 && boundary.legacy_reserved === 8 &&
        boundary.legacy_active_status === 'REGISTRATION_OPEN' && boundary.legacy_exam_status === 'EXAMINATION_ACTIVE');
      check(`RLS replay ${replay} denies IAM/application officer-account inserts and updates`,
        boundary?.iam_officer_insert === false && boundary.iam_officer_update === false &&
        boundary.app_officer_insert === false && boundary.app_officer_update === false);
      check(`RLS replay ${replay} denies direct campaign/session writes while preserving command execution`,
        boundary?.officer_campaign_insert === false && boundary.officer_session_insert === false &&
        boundary.officer_command_execute === true);
      check(`RLS replay ${replay} denies direct seat/payload mutation but keeps relay metadata updates`,
        boundary?.system_seat_update === false && boundary.system_payload_update === false &&
        boundary.system_relay_update === true);
      check(`RLS replay ${replay} keeps provisioner login narrow and separate from the shared app`,
        boundary?.provisioner_login === true && boundary.provisioner_superuser === false &&
        boundary.provisioner_createdb === false && boundary.provisioner_createrole === false &&
        boundary.provisioner_bypassrls === false && boundary.provisioner_inherit === false &&
        boundary.provisioner_member_app === false && boundary.app_member_provisioner === false &&
        boundary.app_member_provision_owner === false && boundary.provisioner_execute === true &&
        boundary.app_provisioner_execute === false);
      check(`RLS replay ${replay} keeps the application lock definer NOLOGIN and narrow`,
        boundary?.lock_function_owner === 'usrp_campaign_application_lock_owner' &&
        boundary.lock_owner_login === false && boundary.lock_owner_table_insert === false &&
        boundary.lock_owner_table_update === false && boundary.lock_owner_updated_at_update === true &&
        boundary.lock_owner_status_update === false && boundary.lock_owner_extra_update_columns === 0 &&
        boundary.lock_owner_id_update === false && boundary.app_member_lock_owner === false &&
        boundary.unsafe_definer_paths === 0);

      await expectPermissionDenied(`RLS replay ${replay} denies IAM officer-account INSERT`, () => upgrade!.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_iam_service`;
        await tx`
          INSERT INTO public_core.officer_accounts
            (officer_id, login_handle, credential, agency, roles, status)
          VALUES (${randomUUID()}::uuid, ${`upgrade-iam-${randomUUID()}`},
                  'scrypt$upgrade$not-a-login-credential', 'RDF', ARRAY['agency_admin']::text[], 'active')`;
      }));
      await expectPermissionDenied(`RLS replay ${replay} denies IAM officer-account UPDATE`, () => upgrade!.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_iam_service`;
        await tx`UPDATE public_core.officer_accounts SET roles = ARRAY['agency_admin']::text[] WHERE false`;
      }));
      await expectPermissionDenied(`RLS replay ${replay} denies shared-app officer-account INSERT`, () => upgrade!.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_app`;
        await tx`
          INSERT INTO public_core.officer_accounts
            (officer_id, login_handle, credential, agency, roles, status)
          VALUES (${randomUUID()}::uuid, ${`upgrade-app-${randomUUID()}`},
                  'scrypt$upgrade$not-a-login-credential', 'RDF', ARRAY['agency_admin']::text[], 'active')`;
      }));
      await expectPermissionDenied(`RLS replay ${replay} denies shared-app officer-account UPDATE`, () => upgrade!.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_app`;
        await tx`UPDATE public_core.officer_accounts SET status = 'disabled' WHERE false`;
      }));
      await expectPermissionDenied(`RLS replay ${replay} denies direct officer campaign UPDATE`, () => upgrade!.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_rdf_officer`;
        await tx`UPDATE public_core.recruitment_campaigns SET status = 'CANCELLED' WHERE id = ${fixtureWithVenues}::uuid`;
      }));
      await expectPermissionDenied(`RLS replay ${replay} denies direct officer session UPDATE`, () => upgrade!.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_rdf_officer`;
        await tx`UPDATE public_core.campaign_venue_assignments SET venue_name = 'forbidden' WHERE campaign_id = ${fixtureWithVenues}::uuid`;
      }));
      await expectPermissionDenied(`RLS replay ${replay} denies direct system registered_count UPDATE`, () => upgrade!.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_system_service`;
        await tx`UPDATE public_core.campaign_venue_assignments SET registered_count = registered_count + 1 WHERE campaign_id = ${fixtureWithVenues}::uuid`;
      }));
      await expectPermissionDenied(`RLS replay ${replay} denies system event payload UPDATE`, () => upgrade!.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_system_service`;
        await tx`UPDATE public_core.event_outbox SET payload = '{}'::jsonb WHERE event_id = ${relayProbeEventId}::uuid`;
      }));
      const relayUpdate = await upgrade.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_system_service`;
        return tx<{ event_id: string }[]>`
          UPDATE public_core.event_outbox
          SET published_at = now(), attempts = attempts + 1
          WHERE event_id = ${relayProbeEventId}::uuid
          RETURNING event_id`;
      });
      const relayProbe = await upgrade<{ producer: string; event_type: string; payload: unknown; attempts: number }[]>`
        SELECT producer, event_type, payload, attempts
        FROM public_core.event_outbox WHERE event_id = ${relayProbeEventId}::uuid`;
      const relayPayload = relayProbe[0]?.payload as Record<string, unknown> | undefined;
      check(`RLS replay ${replay} preserves system relay metadata UPDATE without payload rewrite`,
        relayUpdate.length === 1 && relayProbe[0]?.producer === 'application-service' &&
        relayProbe[0]?.event_type === 'BUILD001_RELAY_PROBE' && relayProbe[0]?.attempts === replay &&
        relayPayload?.['eventType'] === 'BUILD001_RELAY_PROBE' && relayPayload['entityType'] === 'TEST');
    }

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
