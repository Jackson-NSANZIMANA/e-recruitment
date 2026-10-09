// Read-only proof for the dedicated first-campaign-admin database login.
//
// Unlike the BUILD-001 integration proofs that emulate `session_user` with
// SET LOCAL SESSION AUTHORIZATION, this selfcheck creates a real PostgreSQL
// connection through FIRST_ADMIN_DATABASE_URL. It performs no account or audit
// writes: the function probe passes NULL arguments so the function must reach
// its input-validation error (SQLSTATE 22023) after the direct-login guard.
//
// This proves possession/use of the provisioner database credential, not the
// human identity of the person running the CLI. Human attribution needs a
// separately trusted identity/approval source; an operator reference string
// alone is not authentication.
//
// Run manually with the secret supplied through an approved local secret
// channel: pnpm --filter @usrp/iam-service selfcheck:provisioner-auth

import postgres from 'postgres';

const PROVISIONER_ROLE = 'usrp_iam_provisioner';
const PROVISION_FUNCTION =
  'public_core.provision_first_campaign_agency_admin(uuid, text, text, public_core.agency, text, text)';

interface SessionIdentity {
  readonly session_user: string;
  readonly current_user: string;
  readonly tcp_connection: boolean;
}

interface ProvisionerBoundary {
  readonly can_login: boolean | null;
  readonly is_superuser: boolean | null;
  readonly can_create_database: boolean | null;
  readonly can_create_role: boolean | null;
  readonly bypasses_rls: boolean | null;
  readonly inherits_roles: boolean | null;
  readonly member_of_app: boolean;
  readonly member_of_iam_service: boolean;
  readonly member_of_system_service: boolean;
  readonly member_of_private_provision_owner: boolean;
  readonly can_execute_provision_function: boolean;
  readonly can_read_officer_accounts: boolean;
  readonly can_insert_officer_accounts: boolean;
  readonly can_update_officer_accounts: boolean;
  readonly can_insert_event_outbox: boolean;
  readonly can_insert_campaigns: boolean;
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function safeSqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = String((error as { readonly code: unknown }).code);
  return /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['FIRST_ADMIN_DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    console.error('Set FIRST_ADMIN_DATABASE_URL locally via an approved secret channel; this proof never prints it.');
    process.exitCode = 2;
    return;
  }

  const database = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });

  try {
    const identities = await database<SessionIdentity[]>`
      SELECT session_user::text AS session_user,
             current_user::text AS current_user,
             inet_client_addr() IS NOT NULL AS tcp_connection
    `;
    const identity = identities[0];
    const isDirectProvisioner = identity?.session_user === PROVISIONER_ROLE
      && identity.current_user === PROVISIONER_ROLE;

    check('FIRST_ADMIN_DATABASE_URL establishes session_user=current_user=usrp_iam_provisioner',
      isDirectProvisioner);
    check('connection uses TCP rather than a local peer/socket identity', identity?.tcp_connection === true);

    const boundaries = await database<ProvisionerBoundary[]>`
      SELECT
        (SELECT rolcanlogin FROM pg_roles WHERE rolname = ${PROVISIONER_ROLE}) AS can_login,
        (SELECT rolsuper FROM pg_roles WHERE rolname = ${PROVISIONER_ROLE}) AS is_superuser,
        (SELECT rolcreatedb FROM pg_roles WHERE rolname = ${PROVISIONER_ROLE}) AS can_create_database,
        (SELECT rolcreaterole FROM pg_roles WHERE rolname = ${PROVISIONER_ROLE}) AS can_create_role,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = ${PROVISIONER_ROLE}) AS bypasses_rls,
        (SELECT rolinherit FROM pg_roles WHERE rolname = ${PROVISIONER_ROLE}) AS inherits_roles,
        pg_has_role(${PROVISIONER_ROLE}, 'usrp_app', 'MEMBER') AS member_of_app,
        pg_has_role(${PROVISIONER_ROLE}, 'usrp_iam_service', 'MEMBER') AS member_of_iam_service,
        pg_has_role(${PROVISIONER_ROLE}, 'usrp_system_service', 'MEMBER') AS member_of_system_service,
        pg_has_role(${PROVISIONER_ROLE}, 'usrp_campaign_admin_provision_owner', 'MEMBER') AS member_of_private_provision_owner,
        has_function_privilege(${PROVISIONER_ROLE}, ${PROVISION_FUNCTION}, 'EXECUTE') AS can_execute_provision_function,
        has_table_privilege(${PROVISIONER_ROLE}, 'public_core.officer_accounts', 'SELECT') AS can_read_officer_accounts,
        has_table_privilege(${PROVISIONER_ROLE}, 'public_core.officer_accounts', 'INSERT') AS can_insert_officer_accounts,
        has_table_privilege(${PROVISIONER_ROLE}, 'public_core.officer_accounts', 'UPDATE') AS can_update_officer_accounts,
        has_table_privilege(${PROVISIONER_ROLE}, 'public_core.event_outbox', 'INSERT') AS can_insert_event_outbox,
        has_table_privilege(${PROVISIONER_ROLE}, 'public_core.recruitment_campaigns', 'INSERT') AS can_insert_campaigns
    `;
    const boundary = boundaries[0];
    check('provisioner role is LOGIN, NOINHERIT, non-superuser, and has no cluster powers',
      boundary?.can_login === true && boundary.inherits_roles === false &&
      boundary.is_superuser === false && boundary.can_create_database === false &&
      boundary.can_create_role === false && boundary.bypasses_rls === false);
    check('provisioner is not a member of app, service, or private owner roles',
      boundary?.member_of_app === false && boundary.member_of_iam_service === false &&
      boundary.member_of_system_service === false && boundary.member_of_private_provision_owner === false);
    check('provisioner can execute the one-time function but has no direct account/outbox/campaign DML',
      boundary?.can_execute_provision_function === true &&
      boundary.can_read_officer_accounts === false && boundary.can_insert_officer_accounts === false &&
      boundary.can_update_officer_accounts === false && boundary.can_insert_event_outbox === false &&
      boundary.can_insert_campaigns === false);

    if (isDirectProvisioner) {
      const probe = await database.begin(async (tx) => {
        await tx`SAVEPOINT direct_provisioner_auth_probe`;
        try {
          await tx`
            SELECT public_core.provision_first_campaign_agency_admin(
              NULL::uuid,
              NULL::text,
              NULL::text,
              NULL::public_core.agency,
              NULL::text,
              NULL::text
            )
          `;
          await tx`RELEASE SAVEPOINT direct_provisioner_auth_probe`;
          return { sqlState: undefined };
        } catch (error) {
          const sqlState = safeSqlState(error);
          await tx`ROLLBACK TO SAVEPOINT direct_provisioner_auth_probe`;
          await tx`RELEASE SAVEPOINT direct_provisioner_auth_probe`;
          return { sqlState };
        }
      });
      check('direct login passes the function session_user guard; invalid-input probe rolls back without provisioning',
        probe.sqlState === '22023');
    } else {
      check('direct login passes the function session_user guard; invalid-input probe rolls back without provisioning', false);
    }
  } catch (error) {
    const sqlState = safeSqlState(error);
    console.error(`Provisioner proof could not complete${sqlState === undefined ? '' : ` (SQLSTATE ${sqlState})`}; connection details are suppressed.`);
    failed += 1;
  } finally {
    await database.end({ timeout: 5 }).catch(() => {});
  }

  console.log(`\nDIRECT FIRST-ADMIN PROVISIONER AUTH: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log('Direct database identity and privilege boundary proven; human operator identity is a separate claim.');
}

void main().catch((error: unknown) => {
  const sqlState = safeSqlState(error);
  console.error(`Provisioner proof failed unexpectedly${sqlState === undefined ? '' : ` (SQLSTATE ${sqlState})`}; connection details are suppressed.`);
  process.exitCode = 1;
});
