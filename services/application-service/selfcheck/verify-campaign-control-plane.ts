// BUILD-001 P5–P17 and adversarial database proofs. Requires the bootstrapped
// Tier-1 PostgreSQL database. This exercises the real application/scheduling
// services and repositories through officer DB roles, not transaction mocks.

import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { Principal } from '@usrp/shared-auth';
import { asJsonb, sql } from '@usrp/shared-database';
import { campaignCoverageHash, campaignFactUuid, hashCampaignCanonicalJson, hashPassword } from '@usrp/shared-security';
import type { CampaignControlCommand } from '../src/ports/campaign-control.repository.js';
import { CampaignControlService } from '../src/application/campaign-control.service.js';
import { PgCampaignControlRepository } from '../src/adapters/campaign-control.pg-repository.js';
import { PgCampaignPublicReadRepository } from '../src/adapters/campaign-public-read.pg-repository.js';
import { CampaignCommandError } from '../src/domain/campaign-control.errors.js';
import { CampaignInputError } from '../src/domain/campaign-validation.js';
import { PgCampaignReader } from '../src/adapters/campaign.pg-reader.js';
import { AGENCY_TARGET } from '../src/domain/agency-schema.js';
import {
  CampaignUnavailableForApplicationError,
  insertOpeningHistory,
  insertSubmittedApplication,
} from '../src/adapters/application-insert.js';
import {
  CampaignSessionCommandError,
  CampaignSessionService,
} from '../../scheduling-service/src/application/campaign-session.service.js';
import { PgCampaignSessionRepository } from '../../scheduling-service/src/adapters/campaign-session.pg-repository.js';
import { CampaignSessionInputError } from '../../scheduling-service/src/domain/campaign-session-validation.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ADMIN_URL = process.env['ADMIN_DATABASE_URL']
  ?? 'postgresql://usrp_admin:usrp_dev_password@localhost:5432/usrp_db';
const admin = postgres(ADMIN_URL, { onnotice: () => {} });
const PREFIX = `SELFCHK-${randomUUID().slice(0, 8).toUpperCase()}`;
const TARGETS = [
  { district: 'GASABO', province: 'KIGALI_CITY', examDate: '2030-02-03' },
  { district: 'KICUKIRO', province: 'KIGALI_CITY', examDate: '2030-02-04' },
] as const;
const RDF_ACTOR: Principal = {
  kind: 'officer',
  subjectId: randomUUID(),
  agency: 'RDF',
  roles: ['agency_admin'],
};
const RNP_ACTOR: Principal = {
  kind: 'officer',
  subjectId: randomUUID(),
  agency: 'RNP',
  roles: ['agency_admin'],
};
const REVIEWER: Principal = {
  kind: 'officer',
  subjectId: randomUUID(),
  agency: 'RDF',
  roles: ['reviewer'],
};
const OTHER_RDF_ADMIN: Principal = {
  kind: 'officer',
  subjectId: randomUUID(),
  agency: 'RDF',
  roles: ['agency_admin'],
};

const repository = new PgCampaignControlRepository();
const campaign = new CampaignControlService({ repository });
const campaignSessions = new CampaignSessionService(new PgCampaignSessionRepository());
const publicReads = new PgCampaignPublicReadRepository();

let failures = 0;
const applicantIds: string[] = [];
const actorAccountIds = [RDF_ACTOR.subjectId, RNP_ACTOR.subjectId, REVIEWER.subjectId, OTHER_RDF_ADMIN.subjectId];
let legacyPublicCode: string | null = null;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectCode(
  label: string,
  run: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await run();
    check(label, false, `expected ${expectedCode}`);
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { readonly code: unknown }).code)
      : error instanceof CampaignInputError || error instanceof CampaignSessionInputError
        ? error.code
        : '';
    check(label, code === expectedCode, `expected ${expectedCode}, received ${code || String(error)}`);
  }
}

function publicCode(label: string): string {
  return `${PREFIX}-${label.toUpperCase()}`;
}

function draftBody(code: string, districts: readonly string[] = TARGETS.map((item) => item.district)) {
  return {
    publicCode: code,
    campaignLabel: `${PREFIX} ${code.slice(-16)}`.slice(0, 50),
    targetCategories: ['GENERAL_ENLISTMENT'],
    targetDistricts: districts,
    registrationOpensAt: '2030-01-01T08:00:00+02:00',
    registrationClosesAt: '2030-01-31T17:00:00+02:00',
    examinationStartDate: '2030-02-01',
    examinationEndDate: '2030-02-15',
    examinationReportingHour: 8,
    allowsWalkIn: false,
  };
}

// Entirely synthetic policy data; these values are test fixtures, not official
// thresholds, eligibility rules, or legal guidance.
function policyBody(code: string, threshold = 'SELF_CHECK_ONLY') {
  return {
    publicCode: code,
    legalBasisCode: 'SELF_CHECK_FIXTURE',
    legalBasisReference: 'Synthetic proof fixture only; not an official reference.',
    policyDocument: {
      GENERAL_ENLISTMENT: {
        age: { minimumAge: 18, maximumAge: 29, referenceDate: '2030-01-01' },
        education: { mode: 'SELF_CHECK_MODE', threshold },
        criminalThreshold: 'SELF_CHECK_CRIMINAL_RULE',
        requiredDocumentTypes: ['NATIONAL_ID', 'GOOD_CONDUCT_CERTIFICATE'],
        medicalMode: 'SELF_CHECK_MEDICAL_RULE',
        legalBasis: { code: 'SELF_CHECK_FIXTURE', reference: 'Synthetic proof fixture only.' },
      },
    },
  };
}

function sessionBody(code: string, target: (typeof TARGETS)[number], suffix: string, overrides: Record<string, unknown> = {}) {
  return {
    publicCode: code,
    district: target.district,
    province: target.province,
    venueName: `${PREFIX} ${suffix}`,
    examDate: target.examDate,
    reportingTimeHour: 8,
    capacityLimit: 100,
    isActive: true,
    ...overrides,
  };
}

function commandRequest(
  actor: Principal,
  body: unknown,
  idempotencyKey = randomUUID(),
) {
  return { actor, body, idempotencyKey, correlationId: randomUUID() } as const;
}

async function createDraft(label: string, actor: Principal = RDF_ACTOR) {
  const code = publicCode(label);
  const body = draftBody(code);
  const created = await campaign.createDraft(commandRequest(actor, body));
  return { code, campaignId: created.campaignId, body };
}

async function createPolicy(code: string, actor: Principal = RDF_ACTOR) {
  return campaign.createPolicyVersion(commandRequest(actor, policyBody(code)));
}

async function configureAllSessions(code: string, actor: Principal = RDF_ACTOR): Promise<void> {
  for (const target of TARGETS) {
    await campaignSessions.configure(commandRequest(
      actor,
      sessionBody(code, target, `${code.slice(-8)}-${target.district}`),
    ));
  }
}

async function createReadyCampaign(label: string) {
  const draft = await createDraft(label);
  await createPolicy(draft.code);
  await configureAllSessions(draft.code);
  return draft;
}

async function campaignRow(code: string): Promise<{ readonly id: string; readonly status: string } | undefined> {
  const rows = await admin<{ id: string; status: string }[]>`
    SELECT id, status FROM public_core.recruitment_campaigns WHERE public_code = ${code}`;
  return rows[0];
}

async function countForCampaign(table: string, id: string): Promise<number> {
  // Table names are fixed literals supplied only at these call sites.
  const rows = table === 'campaign_publications'
    ? await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM public_core.campaign_publications WHERE campaign_id = ${id}::uuid`
    : table === 'campaign_lifecycle_history'
      ? await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM public_core.campaign_lifecycle_history WHERE campaign_id = ${id}::uuid`
      : table === 'campaign_command_requests'
        ? await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM public_core.campaign_command_requests WHERE resource_id = ${id}::uuid`
        : table === 'campaign_policy_versions'
          ? await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM public_core.campaign_policy_versions WHERE campaign_id = ${id}::uuid`
          : table === 'campaign_venue_assignments'
            ? await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM public_core.campaign_venue_assignments WHERE campaign_id = ${id}::uuid`
            : table === 'session_command_requests'
              ? await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM public_core.session_command_requests WHERE campaign_id = ${id}::uuid`
              : -1;
  return typeof rows === 'number' ? rows : rows[0]?.n ?? -1;
}

interface OutboxRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly producer: string;
  readonly payload: unknown;
}

async function outboxForCampaign(campaignId: string): Promise<OutboxRow[]> {
  return admin<OutboxRow[]>`
    SELECT event_id, event_type, producer, payload
    FROM public_core.event_outbox
    WHERE payload->>'campaignId' = ${campaignId}
       OR payload->>'entityId' = ${campaignId}
    ORDER BY id`;
}

async function createTestApplicantIdentity(): Promise<string> {
  const applicantId = randomUUID();
  applicantIds.push(applicantId);
  const nidHash = createHash('sha256').update(randomUUID()).digest('hex');
  await admin`
    INSERT INTO public_core.applicant_identities
      (id, national_id_hash, encrypted_full_name, encrypted_date_of_birth,
       encrypted_home_district, encrypted_home_province, gender,
       registration_channel, identity_status)
    VALUES (
      ${applicantId}, ${nidHash}, 'x', 'x', 'x', 'x', 'MALE', 'WEB',
      'VERIFIED'::public_core.identity_verification_status
    )`;
  return applicantId;
}

async function insertApplication(campaignId: string): Promise<void> {
  const applicantId = await createTestApplicantIdentity();
  const processingCode = `RDF-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  await admin`
    INSERT INTO rdf_ops.applications
      (id, processing_code, applicant_id, campaign_id, category, status)
    VALUES (
      ${randomUUID()}, ${processingCode}, ${applicantId}, ${campaignId}::uuid,
      'GENERAL_ENLISTMENT', 'SUBMITTED'
    )`;
}

async function seedOfficerTestAccounts(): Promise<void> {
  for (const actor of [RDF_ACTOR, RNP_ACTOR, REVIEWER, OTHER_RDF_ADMIN]) {
    if (actor.kind !== 'officer') throw new Error('selfcheck principal must be an officer');
    await admin`
      INSERT INTO public_core.officer_accounts
        (officer_id, login_handle, credential, agency, roles, status)
      VALUES (
        ${actor.subjectId}::uuid,
        ${`${PREFIX.toLowerCase()}-${actor.agency}-${actor.subjectId.slice(0, 8)}`},
        'scrypt$selfcheck$not-a-login-credential',
        ${actor.agency}::public_core.agency,
        ${[...actor.roles]},
        'active'
      )`;
  }
}

async function cleanup(): Promise<void> {
  await admin.begin(async (tx) => {
    // Self-check teardown is the same documented superuser-only escape hatch
    // used by existing immutability proofs; production code never disables triggers.
    await tx`SET LOCAL session_replication_role = replica`;
    const roots = await tx<{ id: string }[]>`
      SELECT id FROM public_core.recruitment_campaigns
      WHERE public_code LIKE ${`${PREFIX}-%`} OR public_code = ${legacyPublicCode}`;
    const ids = roots.map((row) => row.id);
    if (ids.length > 0) {
      await tx`
        DELETE FROM public_core.event_outbox
        WHERE payload->>'campaignId' IN ${tx(ids)}
          OR payload->>'entityId' IN ${tx(ids)}`;
      await tx`
        DELETE FROM rdf_ops.application_status_history
        WHERE application_id IN (
          SELECT id FROM rdf_ops.applications WHERE campaign_id IN ${tx(ids)}
        )`;
      await tx`DELETE FROM rdf_ops.applications WHERE campaign_id IN ${tx(ids)}`;
      await tx`DELETE FROM public_core.session_command_requests WHERE campaign_id IN ${tx(ids)}`;
      await tx`DELETE FROM public_core.campaign_lifecycle_history WHERE campaign_id IN ${tx(ids)}`;
      await tx`DELETE FROM public_core.campaign_publications WHERE campaign_id IN ${tx(ids)}`;
      await tx`DELETE FROM public_core.campaign_policy_versions WHERE campaign_id IN ${tx(ids)}`;
      await tx`DELETE FROM public_core.campaign_command_requests WHERE resource_id IN ${tx(ids)}`;
      await tx`DELETE FROM public_core.campaign_coverage_heads WHERE campaign_id IN ${tx(ids)}`;
      await tx`DELETE FROM public_core.campaign_venue_assignments WHERE campaign_id IN ${tx(ids)}`;
      await tx`DELETE FROM public_core.recruitment_campaigns WHERE id IN ${tx(ids)}`;
    }
    if (applicantIds.length > 0) {
      await tx`DELETE FROM public_core.applicant_identities WHERE id IN ${tx(applicantIds)}`;
    }
    if (actorAccountIds.length > 0) {
      await tx`DELETE FROM public_core.officer_accounts WHERE officer_id IN ${tx(actorAccountIds)}`;
    }
  });
}

async function expectPgRejected(
  label: string,
  run: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await run();
    check(label, false, 'database mutation was not rejected');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, pattern.test(message), message);
  }
}

async function coverageState(campaignId: string): Promise<{
  readonly version: number;
  readonly hash: string;
  readonly computedHash: string;
  readonly sessionCount: number;
}> {
  const headRows = await admin<{ coverage_version: number; coverage_hash: string }[]>`
    SELECT coverage_version, coverage_hash
    FROM public_core.campaign_coverage_heads WHERE campaign_id = ${campaignId}::uuid`;
  const sessions = await admin<{
    district: string;
    province: string;
    venue_name: string;
    exam_date: string;
    reporting_time_hour: number;
    capacity_limit: number | null;
    is_active: boolean;
  }[]>`
    SELECT district, province, venue_name, exam_date, reporting_time_hour,
           capacity_limit, is_active
    FROM public_core.campaign_venue_assignments
    WHERE campaign_id = ${campaignId}::uuid`;
  const head = headRows[0];
  if (head === undefined) throw new Error(`Missing coverage head for ${campaignId}`);
  const computedHash = campaignCoverageHash(campaignId, sessions.map((session) => ({
    district: session.district,
    province: session.province,
    venueName: session.venue_name,
    examDate: session.exam_date,
    reportingTimeHour: session.reporting_time_hour,
    capacityLimit: session.capacity_limit,
    isActive: session.is_active,
  })));
  return {
    version: head.coverage_version,
    hash: head.coverage_hash,
    computedHash,
    sessionCount: sessions.length,
  };
}

async function verifyFirstAdminProvisioningSemantics(): Promise<void> {
  const rdfId = randomUUID();
  const rnpId = randomUUID();
  const rdfHandle = `selfcheck-rdf-${randomUUID().slice(0, 8)}`;
  const rnpHandle = `selfcheck-rnp-${randomUUID().slice(0, 8)}`;
  const rollbackMarker = `ROLLBACK_FIRST_ADMIN_SELF_CHECK_${randomUUID()}`;
  let transactionRolledBack = false;

  try {
    await admin.begin(async (tx) => {
      // Hide existing admin rows only inside this uncommitted proof transaction.
      // They remain visible to other sessions and are restored by the forced
      // rollback below; this gives the function a clean first-admin state.
      await tx`
        DELETE FROM public_core.officer_accounts
        WHERE agency IN ('RDF'::public_core.agency, 'RNP'::public_core.agency)
          AND 'agency_admin' = ANY(roles)
      `;
      // This test's admin connection uses SET LOCAL SESSION AUTHORIZATION to
      // emulate the function's session_user check. It does not prove a direct
      // usrp_iam_provisioner password login or independently authenticate a
      // human operator; the operator CLI has a separate direct-login guard.
      await tx`SET LOCAL SESSION AUTHORIZATION usrp_iam_provisioner`;
      const identity = await tx<{ session_user: string; current_user: string }[]>`
        SELECT session_user, current_user
      `;
      check('admin-emulated provisioner session identity satisfies the function guard (not direct password authentication)',
        identity[0]?.session_user === 'usrp_iam_provisioner' &&
        identity[0]?.current_user === 'usrp_iam_provisioner');

      const callProvisioner = async (
        officerId: string,
        loginHandle: string,
        agency: 'RDF' | 'RNP',
      ): Promise<{ readonly ok: boolean; readonly error: string }> => {
        await tx`SAVEPOINT first_admin_call`;
        try {
          await tx`
            SELECT public_core.provision_first_campaign_agency_admin(
              ${officerId}::uuid,
              ${loginHandle},
              ${hashPassword(`BUILD001-SELF-CHECK-${randomUUID()}`)},
              ${agency}::public_core.agency,
              'SELF-CHECK-CHANGE',
              'SELF-CHECK-CORRELATION'
            )
          `;
          await tx`RELEASE SAVEPOINT first_admin_call`;
          return { ok: true, error: '' };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await tx`ROLLBACK TO SAVEPOINT first_admin_call`;
          await tx`RELEASE SAVEPOINT first_admin_call`;
          return { ok: false, error: message };
        }
      };

      const rdf = await callProvisioner(rdfId, rdfHandle, 'RDF');
      const rnp = await callProvisioner(rnpId, rnpHandle, 'RNP');
      const repeatedRdf = await callProvisioner(randomUUID(), `selfcheck-repeat-${randomUUID().slice(0, 8)}`, 'RDF');
      check('first-admin provisioning succeeds once for each of two distinct agencies', rdf.ok && rnp.ok,
        `${rdf.error} ${rnp.error}`.trim());
      check('repeat provisioning is rejected for an initialized agency without blocking the other agency',
        !repeatedRdf.ok && /FIRST_ADMIN_ALREADY_PROVISIONED/.test(repeatedRdf.error), repeatedRdf.error);

      await tx`RESET SESSION AUTHORIZATION`;
      const accounts = await tx<{
        officer_id: string;
        agency: string;
        roles: readonly string[];
      }[]>`
        SELECT officer_id, agency::text AS agency, roles
        FROM public_core.officer_accounts
        WHERE officer_id IN (${rdfId}::uuid, ${rnpId}::uuid)
        ORDER BY agency
      `;
      check('each first administrator is stored only under its requested agency with agency_admin role',
        accounts.length === 2 &&
        accounts.some((row) => row.officer_id === rdfId && row.agency === 'RDF' && row.roles.length === 1 && row.roles[0] === 'agency_admin') &&
        accounts.some((row) => row.officer_id === rnpId && row.agency === 'RNP' && row.roles.length === 1 && row.roles[0] === 'agency_admin'));

      const auditRows = await tx<{
        entity_id: string;
        agency: string | null;
        action: string | null;
        has_secret_fields: boolean;
      }[]>`
        SELECT payload->>'entityId' AS entity_id,
               payload->>'agency' AS agency,
               payload->>'action' AS action,
               payload ?| ARRAY['password', 'credential', 'loginHandle'] AS has_secret_fields
        FROM public_core.event_outbox
        WHERE producer = 'iam-service'
          AND event_type = 'AUDIT_ENTRY'
          AND payload->>'action' = 'FIRST_CAMPAIGN_AGENCY_ADMIN_PROVISIONED'
          AND payload->>'entityId' IN (${rdfId}, ${rnpId})
      `;
      check('first-admin success writes exactly one agency-matched, credential-free audit outbox event per account',
        auditRows.length === 2 &&
        auditRows.some((row) => row.entity_id === rdfId && row.agency === 'RDF' && row.action === 'FIRST_CAMPAIGN_AGENCY_ADMIN_PROVISIONED' && !row.has_secret_fields) &&
        auditRows.some((row) => row.entity_id === rnpId && row.agency === 'RNP' && row.action === 'FIRST_CAMPAIGN_AGENCY_ADMIN_PROVISIONED' && !row.has_secret_fields));

      throw new Error(rollbackMarker);
    });
  } catch (error) {
    if (error instanceof Error && error.message === rollbackMarker) transactionRolledBack = true;
    else throw error;
  }

  const residue = await admin<{ accounts: number; audit_events: number }[]>`
    SELECT
      (SELECT count(*)::int FROM public_core.officer_accounts WHERE officer_id IN (${rdfId}::uuid, ${rnpId}::uuid)) AS accounts,
      (SELECT count(*)::int FROM public_core.event_outbox WHERE payload->>'entityId' IN (${rdfId}, ${rnpId}) AND payload->>'action' = 'FIRST_CAMPAIGN_AGENCY_ADMIN_PROVISIONED') AS audit_events
  `;
  check('first-admin acceptance fixture rolled back completely and restored pre-existing administrators',
    transactionRolledBack && residue[0]?.accounts === 0 && residue[0]?.audit_events === 0);
}

async function main(): Promise<void> {
  try {
    await cleanup();
    await seedOfficerTestAccounts();
    console.log('\n── P5. Draft persistence, lifecycle history, and idempotency ──');
    const idemCode = publicCode('IDEMPOTENCY');
    const idemBody = draftBody(idemCode);
    const idemKey = randomUUID();
    const firstDraft = await campaign.createDraft(commandRequest(RDF_ACTOR, idemBody, idemKey));
    const replayDraft = await campaign.createDraft(commandRequest(RDF_ACTOR, idemBody, idemKey));
    check('same actor/op/key/hash replays the original draft result',
      replayDraft.replayed && replayDraft.commandId === firstDraft.commandId);
    check('replay returns the original response status and body',
      replayDraft.responseStatus === firstDraft.responseStatus &&
      JSON.stringify(replayDraft.responseBody) === JSON.stringify(firstDraft.responseBody));
    await expectCode('same actor/op/key with a different request hash is rejected', () =>
      campaign.createDraft(commandRequest(RDF_ACTOR, draftBody(publicCode('REUSED')), idemKey)),
    'IDEMPOTENCY_KEY_REUSED');
    check('reused-key conflict did not create a second campaign',
      await campaignRow(publicCode('REUSED')) === undefined);
    check('draft starts in DRAFT with exactly one initial history row',
      (await campaignRow(idemCode))?.status === 'DRAFT' &&
      await countForCampaign('campaign_lifecycle_history', firstDraft.campaignId) === 1);
    check('draft replay did not stage duplicate outbox rows',
      (await outboxForCampaign(firstDraft.campaignId)).length === 2);
    check('unpublished draft is not available in public detail',
      await publicReads.findPublishedByCode(idemCode) === null);

    console.log('\n── P5a. Functions-only DML boundary and role-backed denials ─');
    const boundaryPrivileges = await admin<{
      readonly rdf_campaign_insert: boolean;
      readonly rdf_campaign_update: boolean;
      readonly rdf_session_insert: boolean;
      readonly rdf_history_insert: boolean;
      readonly system_seat_update: boolean;
      readonly system_payload_update: boolean;
      readonly rdf_command_execute: boolean;
      readonly system_reservation_execute: boolean;
      readonly command_owner_login: boolean;
      readonly command_owner_bypass_rls: boolean;
      readonly app_can_assume_command_owner: boolean;
      readonly provision_owner_login: boolean;
      readonly app_can_assume_provision_owner: boolean;
      readonly app_campaign_insert: boolean;
      readonly app_campaign_update: boolean;
      readonly app_session_insert: boolean;
      readonly app_session_update: boolean;
      readonly app_history_insert: boolean;
      readonly app_can_assume_iam_service: boolean;
      readonly app_can_assume_iam_provisioner: boolean;
      readonly provisioner_login: boolean;
      readonly provisioner_superuser: boolean;
      readonly provisioner_createdb: boolean;
      readonly provisioner_createrole: boolean;
      readonly provisioner_bypassrls: boolean;
      readonly provisioner_inherit: boolean;
      readonly provisioner_member_app: boolean;
      readonly provisioner_member_iam_service: boolean;
      readonly provisioner_member_system_service: boolean;
      readonly provisioner_campaign_insert: boolean;
      readonly provisioner_execute: boolean;
      readonly iam_service_execute_provisioner: boolean;
      readonly app_execute_provisioner: boolean;
      readonly provisioner_account_select: boolean;
      readonly provisioner_account_insert: boolean;
      readonly provisioner_outbox_insert: boolean;
      readonly unsafe_definer_search_paths: number;
      readonly command_definer_count: number;
    }[]>`
      SELECT
        has_table_privilege('usrp_rdf_officer', 'public_core.recruitment_campaigns', 'INSERT') AS rdf_campaign_insert,
        has_column_privilege('usrp_rdf_officer', 'public_core.recruitment_campaigns', 'status', 'UPDATE') AS rdf_campaign_update,
        has_table_privilege('usrp_rdf_officer', 'public_core.campaign_venue_assignments', 'INSERT') AS rdf_session_insert,
        has_table_privilege('usrp_rdf_officer', 'public_core.campaign_lifecycle_history', 'INSERT') AS rdf_history_insert,
        has_column_privilege('usrp_system_service', 'public_core.campaign_venue_assignments', 'registered_count', 'UPDATE') AS system_seat_update,
        has_column_privilege('usrp_system_service', 'public_core.event_outbox', 'payload', 'UPDATE') AS system_payload_update,
        has_function_privilege('usrp_rdf_officer', 'public_core.campaign_write_draft(jsonb)', 'EXECUTE') AS rdf_command_execute,
        has_function_privilege('usrp_system_service', 'public_core.reserve_campaign_venue_seat(uuid)', 'EXECUTE') AS system_reservation_execute,
        (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'usrp_campaign_command_owner') AS command_owner_login,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'usrp_campaign_command_owner') AS command_owner_bypass_rls,
        pg_has_role('usrp_app', 'usrp_campaign_command_owner', 'MEMBER') AS app_can_assume_command_owner,
        (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'usrp_campaign_admin_provision_owner') AS provision_owner_login,
        pg_has_role('usrp_app', 'usrp_campaign_admin_provision_owner', 'MEMBER') AS app_can_assume_provision_owner,
        has_table_privilege('usrp_app', 'public_core.recruitment_campaigns', 'INSERT') AS app_campaign_insert,
        has_column_privilege('usrp_app', 'public_core.recruitment_campaigns', 'status', 'UPDATE') AS app_campaign_update,
        has_table_privilege('usrp_app', 'public_core.campaign_venue_assignments', 'INSERT') AS app_session_insert,
        has_column_privilege('usrp_app', 'public_core.campaign_venue_assignments', 'capacity_limit', 'UPDATE') AS app_session_update,
        has_table_privilege('usrp_app', 'public_core.campaign_lifecycle_history', 'INSERT') AS app_history_insert,
        pg_has_role('usrp_app', 'usrp_iam_service', 'MEMBER') AS app_can_assume_iam_service,
        pg_has_role('usrp_app', 'usrp_iam_provisioner', 'MEMBER') AS app_can_assume_iam_provisioner,
        (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_login,
        (SELECT rolsuper FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_superuser,
        (SELECT rolcreatedb FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_createdb,
        (SELECT rolcreaterole FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_createrole,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_bypassrls,
        (SELECT rolinherit FROM pg_roles WHERE rolname = 'usrp_iam_provisioner') AS provisioner_inherit,
        pg_has_role('usrp_iam_provisioner', 'usrp_app', 'MEMBER') AS provisioner_member_app,
        pg_has_role('usrp_iam_provisioner', 'usrp_iam_service', 'MEMBER') AS provisioner_member_iam_service,
        pg_has_role('usrp_iam_provisioner', 'usrp_system_service', 'MEMBER') AS provisioner_member_system_service,
        has_table_privilege('usrp_iam_provisioner', 'public_core.recruitment_campaigns', 'INSERT') AS provisioner_campaign_insert,
        has_function_privilege('usrp_iam_provisioner', 'public_core.provision_first_campaign_agency_admin(uuid,text,text,public_core.agency,text,text)', 'EXECUTE') AS provisioner_execute,
        has_function_privilege('usrp_iam_service', 'public_core.provision_first_campaign_agency_admin(uuid,text,text,public_core.agency,text,text)', 'EXECUTE') AS iam_service_execute_provisioner,
        has_function_privilege('usrp_app', 'public_core.provision_first_campaign_agency_admin(uuid,text,text,public_core.agency,text,text)', 'EXECUTE') AS app_execute_provisioner,
        has_table_privilege('usrp_iam_provisioner', 'public_core.officer_accounts', 'SELECT') AS provisioner_account_select,
        has_table_privilege('usrp_iam_provisioner', 'public_core.officer_accounts', 'INSERT') AS provisioner_account_insert,
        has_table_privilege('usrp_iam_provisioner', 'public_core.event_outbox', 'INSERT') AS provisioner_outbox_insert,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE r.rolname IN ('usrp_campaign_command_owner', 'usrp_campaign_admin_provision_owner')
            AND p.prosecdef AND NOT ('search_path=pg_catalog' = ANY(COALESCE(p.proconfig, ARRAY[]::text[])))) AS unsafe_definer_search_paths,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE r.rolname IN ('usrp_campaign_command_owner', 'usrp_campaign_admin_provision_owner')
            AND p.prosecdef) AS command_definer_count`;
    const boundary = boundaryPrivileges[0];
    check('campaign-admin DB role has no direct campaign/session/history DML and uses command functions',
      boundary?.rdf_campaign_insert === false && boundary.rdf_campaign_update === false &&
      boundary.rdf_session_insert === false && boundary.rdf_history_insert === false &&
      boundary.rdf_command_execute === true);
    check('legacy seat counter and outbox payload are not directly mutable by system role',
      boundary?.system_seat_update === false && boundary.system_payload_update === false &&
      boundary.system_reservation_execute === true);
    check('private BYPASSRLS function owners are NOLOGIN and cannot be assumed by the app',
      boundary?.command_owner_login === false && boundary.command_owner_bypass_rls === true &&
      boundary.app_can_assume_command_owner === false && boundary.provision_owner_login === false &&
      boundary.app_can_assume_provision_owner === false);
    check('application DB login itself has no campaign/session/history DML',
      boundary?.app_campaign_insert === false && boundary.app_campaign_update === false &&
      boundary.app_session_insert === false && boundary.app_session_update === false &&
      boundary.app_history_insert === false);
    check('usrp_app may assume IAM for shared-backend authentication but cannot assume the dedicated provisioner',
      boundary?.app_can_assume_iam_service === true && boundary.app_can_assume_iam_provisioner === false);
    check('first-admin function is executable only by the standalone provisioner login',
      boundary?.provisioner_login === true && boundary.provisioner_superuser === false &&
      boundary.provisioner_createdb === false && boundary.provisioner_createrole === false &&
      boundary.provisioner_bypassrls === false && boundary.provisioner_inherit === false &&
      boundary.provisioner_member_app === false && boundary.provisioner_member_iam_service === false &&
      boundary.provisioner_member_system_service === false && boundary.provisioner_campaign_insert === false &&
      boundary.provisioner_execute === true && boundary.iam_service_execute_provisioner === false &&
      boundary.app_execute_provisioner === false && boundary.provisioner_account_select === false &&
      boundary.provisioner_account_insert === false && boundary.provisioner_outbox_insert === false);
    check('all campaign SECURITY DEFINER functions pin search_path to pg_catalog',
      boundary?.command_definer_count !== undefined && boundary.command_definer_count > 0 &&
      boundary.unsafe_definer_search_paths === 0);
    const iamRoleSwitch = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_iam_service`;
      return await tx<{ session_user: string; current_user: string }[]>`
        SELECT session_user, current_user
      `;
    });
    check('live app session can SET ROLE usrp_iam_service (explicit shared-backend trust boundary)',
      iamRoleSwitch[0]?.session_user === 'usrp_app' && iamRoleSwitch[0]?.current_user === 'usrp_iam_service');
    await expectPgRejected('usrp_app cannot directly update campaign state', () => sql.begin(async (tx) => {
      await tx`
        UPDATE public_core.recruitment_campaigns
        SET status = 'CANCELLED'
        WHERE id = ${firstDraft.campaignId}::uuid
      `;
    }), /permission denied|insufficient privilege/i);
    await expectPgRejected('usrp_app cannot assume the dedicated first-admin provisioner login', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_iam_provisioner`;
    }), /permission denied to set role|not a member/i);
    await expectPgRejected('usrp_app cannot provision first-admin even after assuming usrp_iam_service', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_iam_service`;
      await tx`
        SELECT public_core.provision_first_campaign_agency_admin(
          ${randomUUID()}::uuid, 'selfcheck-operator-bypass', 'scrypt$selfcheck$not-a-login-credential',
          'RDF'::public_core.agency, 'SELF-CHECK-OP', 'SELF-CHECK-CORR'
        )
      `;
    }), /permission denied for function|insufficient privilege/i);
    await expectPgRejected('a direct NOLOGIN officer database session cannot invoke campaign command functions', () => admin.begin(async (tx) => {
      await tx`SET LOCAL SESSION AUTHORIZATION usrp_rdf_officer`;
      await tx`
        SELECT public_core.campaign_write_draft(
          ${tx.json(asJsonb({ actorId: RDF_ACTOR.subjectId, agency: 'RDF' }))}
        )
      `;
    }), /campaign commands are available only to the application database login/i);
    await verifyFirstAdminProvisioningSemantics();

    await expectPgRejected('RDF database role cannot invoke an RNP command for an RNP administrator', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      await tx`SELECT set_config('usrp.campaign_actor_id', ${RNP_ACTOR.subjectId}, true)`;
      await tx`
        SELECT * FROM public_core.campaign_lock_for_command(
          ${RNP_ACTOR.subjectId}::uuid, 'RNP'::public_core.agency, 'CROSS-AGENCY-SELF-CHECK'
        )
      `;
    }), /campaign DB role does not match the requested agency/i);
    await expectPgRejected('publication function rejects another active RDF admin UUID outside transaction actor context', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      await tx`SELECT set_config('usrp.campaign_actor_id', ${RDF_ACTOR.subjectId}, true)`;
      await tx`
        SELECT public_core.campaign_write_publication(
          ${tx.json(asJsonb({ actorId: OTHER_RDF_ADMIN.subjectId, agency: 'RDF' }))}
        )
      `;
    }), /actor does not match transaction actor context/i);

    await expectPgRejected('campaign-admin role cannot directly update campaign state', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      await tx`
        UPDATE public_core.recruitment_campaigns
        SET status = 'CANCELLED'
        WHERE id = ${firstDraft.campaignId}::uuid
      `;
    }), /permission denied|insufficient privilege/i);
    await expectPgRejected('campaign-admin role cannot directly insert a campaign session', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      await tx`
        INSERT INTO public_core.campaign_venue_assignments
          (id, campaign_id, district, province, venue_name, exam_date,
           reporting_time_hour, capacity_limit, registered_count, is_active)
        VALUES (
          ${randomUUID()}::uuid, ${firstDraft.campaignId}::uuid, 'GASABO', 'KIGALI_CITY',
          'direct-DML-forbidden', '2030-02-03', 8, 100, 0, true
        )
      `;
    }), /permission denied|insufficient privilege/i);
    await expectPgRejected('campaign-admin role cannot insert standalone lifecycle history', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      await tx`
        INSERT INTO public_core.campaign_lifecycle_history
          (id, campaign_id, agency, from_status, to_status, actor_id, correlation_id)
        VALUES (
          ${randomUUID()}::uuid, ${firstDraft.campaignId}::uuid, 'RDF', NULL, 'DRAFT',
          ${RDF_ACTOR.subjectId}::uuid, ${randomUUID()}
        )
      `;
    }), /permission denied|insufficient privilege/i);
    await expectPgRejected('system scheduler cannot directly mutate registered_count', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_system_service`;
      await tx`
        UPDATE public_core.campaign_venue_assignments
        SET registered_count = registered_count + 1
        WHERE campaign_id = ${firstDraft.campaignId}::uuid
      `;
    }), /permission denied|insufficient privilege/i);
    await expectPgRejected('officer role cannot forge a campaign action under another audit entity type', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rdf_officer`;
      const eventId = randomUUID();
      await tx`
        INSERT INTO public_core.event_outbox (event_id, event_type, producer, payload)
        VALUES (
          ${eventId}::uuid, 'AUDIT_ENTRY', 'application-service',
          ${tx.json(asJsonb({
            eventId,
            eventType: 'AUDIT_ENTRY',
            entityType: 'OFFICER',
            entityId: RDF_ACTOR.subjectId,
            action: 'CAMPAIGN_SESSION_CONFIGURED',
          }))}
        )
      `;
    }), /row-level security|permission denied|policy/i);
    await expectPgRejected('system scheduler cannot forge a campaign domain event directly', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_system_service`;
      const eventId = randomUUID();
      await tx`
        INSERT INTO public_core.event_outbox (event_id, event_type, producer, payload)
        VALUES (
          ${eventId}::uuid, 'CAMPAIGN_PUBLISHED', 'scheduling-service',
          ${tx.json(asJsonb({ eventId, eventType: 'CAMPAIGN_PUBLISHED', entityType: 'CAMPAIGN', campaignId: firstDraft.campaignId }))}
        )
      `;
    }), /row-level security|permission denied|policy/i);
    await expectPgRejected('system scheduler cannot forge a campaign audit under another entity type', () => sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_system_service`;
      const eventId = randomUUID();
      await tx`
        INSERT INTO public_core.event_outbox (event_id, event_type, producer, payload)
        VALUES (
          ${eventId}::uuid, 'AUDIT_ENTRY', 'scheduling-service',
          ${tx.json(asJsonb({
            eventId,
            eventType: 'AUDIT_ENTRY',
            entityType: 'OFFICER',
            entityId: RDF_ACTOR.subjectId,
            action: 'CAMPAIGN_PUBLISHED',
          }))}
        )
      `;
    }), /row-level security|permission denied|policy/i);

    console.log('\n── P6. Permission, verified agency, and RLS isolation ────────');
    await expectCode('reviewer cannot create a campaign', () =>
      campaign.createDraft(commandRequest(REVIEWER, draftBody(publicCode('UNAUTHORIZED')))),
    'FORBIDDEN');
    await expectCode('reviewer cannot complete a campaign', () =>
      campaign.complete(commandRequest(REVIEWER, { publicCode: idemCode })),
    'FORBIDDEN');
    await expectCode('system principal cannot create a campaign', () =>
      campaign.createDraft(commandRequest({ kind: 'system', subjectId: randomUUID() }, draftBody(publicCode('SYSTEM-FORBIDDEN')))),
    'FORBIDDEN');
    await expectCode('cross-agency policy read is hidden as not found', () =>
      campaign.createPolicyVersion(commandRequest(RNP_ACTOR, policyBody(idemCode))),
    'CAMPAIGN_NOT_FOUND');
    await expectCode('cross-agency session write is hidden as not found', () =>
      campaignSessions.configure(commandRequest(RNP_ACTOR, sessionBody(idemCode, TARGETS[0], 'CROSS-AGENCY'))),
    'CAMPAIGN_NOT_FOUND');
    const crossAgencyCounts = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rnp_officer`;
      const root = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public_core.recruitment_campaigns
        WHERE id = ${firstDraft.campaignId}::uuid`;
      const sessions = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public_core.campaign_venue_assignments
        WHERE campaign_id = ${firstDraft.campaignId}::uuid`;
      return { root: root[0]?.n ?? -1, sessions: sessions[0]?.n ?? -1 };
    });
    check('RNP database role cannot see RDF campaign or its sessions',
      crossAgencyCounts.root === 0 && crossAgencyCounts.sessions === 0,
      JSON.stringify(crossAgencyCounts));
    const submissionLockPrivileges = await admin<{ direct_update: boolean; helper_execute: boolean }[]>`
      SELECT
        has_table_privilege(
          'usrp_system_service',
          'public_core.recruitment_campaigns',
          'UPDATE'
        ) AS direct_update,
        has_function_privilege(
          'usrp_system_service',
          'public_core.lock_campaign_for_application_insert(uuid,public_core.agency)',
          'EXECUTE'
        ) AS helper_execute`;
    check('submission gets a narrow row-lock helper without broad campaign UPDATE',
      submissionLockPrivileges[0]?.direct_update === false &&
      submissionLockPrivileges[0]?.helper_execute === true);
    const crossAgencyLockRead = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE usrp_rnp_officer`;
      return await tx<{ status: string }[]>`
        SELECT status
        FROM public_core.lock_campaign_for_application_insert(
          ${firstDraft.campaignId}::uuid,
          'RDF'::public_core.agency
        )`;
    });
    check('officer lock helper cannot resolve a sibling-agency campaign',
      crossAgencyLockRead.length === 0);

    console.log('\n── P7. Policy versions are immutable and monotonic ────────────');
    const policyDraft = await createDraft('POLICY-VERSIONS');
    const policyV1 = await createPolicy(policyDraft.code);
    const policyV2 = await campaign.createPolicyVersion(commandRequest(
      RDF_ACTOR,
      policyBody(policyDraft.code, 'SECOND_SYNTHETIC_FIXTURE'),
    ));
    check('policy version numbers increase monotonically',
      policyV1.responseBody['policyVersion'] === 1 && policyV2.responseBody['policyVersion'] === 2);
    const policyRows = await admin<{ id: string; version_number: number; policy_hash: string }[]>`
      SELECT id, version_number, policy_hash FROM public_core.campaign_policy_versions
      WHERE campaign_id = ${policyDraft.campaignId}::uuid ORDER BY version_number`;
    check('both policy versions and lowercase hashes persisted',
      policyRows.length === 2 && policyRows.every((row) => /^[0-9a-f]{64}$/.test(row.policy_hash)));
    const firstPolicyRow = policyRows[0];
    const secondPolicyRow = policyRows[1];
    if (firstPolicyRow === undefined || secondPolicyRow === undefined) {
      throw new Error('Policy-version fixture rows were not persisted.');
    }
    await expectPgRejected('database rejects update of an immutable policy version', () =>
      admin`UPDATE public_core.campaign_policy_versions SET policy_hash = policy_hash WHERE id = ${firstPolicyRow.id}::uuid`,
    /append-only/);
    const selectedPolicy = await admin<{ current_policy_version_id: string }[]>`
      SELECT current_policy_version_id FROM public_core.recruitment_campaigns WHERE id = ${policyDraft.campaignId}::uuid`;
    check('campaign points at the newest validated policy version',
      selectedPolicy[0]?.current_policy_version_id === policyRows[1]?.id);

    console.log('\n── P8. Session configuration, coverage, capacity, and completeness ─');
    const incomplete = await createDraft('INCOMPLETE-COVERAGE');
    await createPolicy(incomplete.code);
    await expectCode('NULL capacity requires an explicit UNBOUNDED_CAPACITY decision', () =>
      campaignSessions.configure(commandRequest(
        RDF_ACTOR,
        sessionBody(incomplete.code, TARGETS[0], 'MISSING-UNBOUNDED-DECISION', { capacityLimit: null }),
      )),
    'CAPACITY_DECISION_REQUIRED');
    const unboundedSession = await campaignSessions.configure(commandRequest(
      RDF_ACTOR,
      sessionBody(incomplete.code, TARGETS[0], 'INCOMPLETE-GASABO', {
        capacityLimit: null,
        capacityDecisionCode: 'UNBOUNDED_CAPACITY',
      }),
    ));
    const unboundedRow = await admin<{ capacity_decision_code: string | null }[]>`
      SELECT capacity_decision_code FROM public_core.campaign_venue_assignments
      WHERE campaign_id = ${incomplete.campaignId}::uuid AND district = 'GASABO'`;
    const unboundedAudit = await admin<{ decision: string | null }[]>`
      SELECT payload->'metadata'->>'capacityDecisionCode' AS decision
      FROM public_core.event_outbox
      WHERE event_type = 'AUDIT_ENTRY'
        AND payload->>'entityId' = ${incomplete.campaignId}
        AND payload->>'action' = 'CAMPAIGN_SESSION_CONFIGURED'
      LIMIT 1`;
    check('unbounded capacity decision is persisted and explicitly audited',
      unboundedSession.responseBody['capacityDecisionCode'] === 'UNBOUNDED_CAPACITY' &&
      unboundedRow[0]?.capacity_decision_code === 'UNBOUNDED_CAPACITY' &&
      unboundedAudit[0]?.decision === 'UNBOUNDED_CAPACITY');
    const incompleteBefore = await coverageState(incomplete.campaignId);
    check('one configured target creates versioned coverage evidence',
      incompleteBefore.version === 1 && incompleteBefore.hash === incompleteBefore.computedHash);
    await expectCode('publication rejects missing district coverage', () =>
      campaign.publish(commandRequest(RDF_ACTOR, { publicCode: incomplete.code })),
    'INCOMPLETE_COVERAGE');
    await expectCode('zero capacity is rejected before persistence', () =>
      campaignSessions.configure(commandRequest(
        RDF_ACTOR,
        sessionBody(incomplete.code, TARGETS[1], 'INVALID-ZERO-CAPACITY', { capacityLimit: 0 }),
      )),
    'INVALID_REQUEST');
    await expectPgRejected('database guard rejects invalid zero capacity', () =>
      admin`
        INSERT INTO public_core.campaign_venue_assignments
          (campaign_id, district, province, venue_name, exam_date,
           reporting_time_hour, capacity_limit, registered_count, is_active)
        VALUES (
          ${incomplete.campaignId}::uuid, 'KICUKIRO', 'KIGALI_CITY',
          'invalid capacity fixture', '2030-02-04', 8, 0, 0, true
        )`,
    /capacity must be positive/);
    const secondTarget = TARGETS[1];
    const secondBody = sessionBody(incomplete.code, secondTarget, 'INCOMPLETE-KICUKIRO');
    const sessionKey = randomUUID();
    const firstSession = await campaignSessions.configure(commandRequest(RDF_ACTOR, secondBody, sessionKey));
    const beforeReplayCount = (await outboxForCampaign(incomplete.campaignId)).length;
    const replaySession = await campaignSessions.configure(commandRequest(RDF_ACTOR, secondBody, sessionKey));
    check('session command retry replays the original response',
      replaySession.replayed && replaySession.commandId === firstSession.commandId);
    check('session replay stages no duplicate domain/audit rows',
      (await outboxForCampaign(incomplete.campaignId)).length === beforeReplayCount);
    const completeCoverage = await coverageState(incomplete.campaignId);
    check('coverage version advances once per changed session and hashes the exact set',
      completeCoverage.version === 2 && completeCoverage.sessionCount === 2 &&
      completeCoverage.hash === completeCoverage.computedHash);

    console.log('\n── P9. Valid publication freezes policy and coverage ──────────');
    const published = await campaign.publish(commandRequest(RDF_ACTOR, { publicCode: incomplete.code }));
    const publishedRow = await campaignRow(incomplete.code);
    const evidence = await admin<{
      publication_version: number;
      publication_hash: string;
      head_version: number;
      head_hash: string;
    }[]>`
      SELECT p.coverage_version AS publication_version, p.coverage_hash AS publication_hash,
             h.coverage_version AS head_version, h.coverage_hash AS head_hash
      FROM public_core.campaign_publications p
      JOIN public_core.campaign_coverage_heads h ON h.campaign_id = p.campaign_id
      WHERE p.campaign_id = ${incomplete.campaignId}::uuid`;
    const coverage = await coverageState(incomplete.campaignId);
    check('publication performs DRAFT → REGISTRATION_OPEN and stores a publication fact',
      publishedRow?.status === 'REGISTRATION_OPEN' && await countForCampaign('campaign_publications', incomplete.campaignId) === 1);
    check('publication freezes matching coverage version/hash evidence',
      published.fact?.kind === 'PUBLISHED' && evidence[0]?.publication_version === coverage.version &&
      evidence[0]?.publication_hash === coverage.hash && evidence[0]?.head_hash === coverage.computedHash);
    await expectCode('policy amendment is rejected after publication', () =>
      createPolicy(incomplete.code, RDF_ACTOR),
    'INVALID_STATE');
    await expectPgRejected('database prevents published campaign structure changes', () =>
      admin`UPDATE public_core.recruitment_campaigns SET campaign_label = campaign_label || '-MUTATED' WHERE id = ${incomplete.campaignId}::uuid`,
    /campaign structure is immutable/);

    console.log('\n── P10. Public projection is published-only and allowlisted ───');
    const detail = await publicReads.findPublishedByCode(incomplete.code);
    const expectedPublicKeys = [
      'publicCode', 'campaignLabel', 'agency', 'status', 'registrationOpensAt',
      'registrationClosesAt', 'examinationStartDate', 'examinationEndDate',
      'targetCategories', 'targetDistricts', 'allowsWalkIn', 'contactPhoneNumbers',
      'contactWebsite',
    ].sort();
    const privateNames = [
      'id', 'campaignId', 'policyDocument', 'policyHash', 'coverageHash',
      'capacityLimit', 'registeredCount', 'officerId', 'auditMetadata',
    ];
    check('public detail is addressable by publicCode after publication',
      detail?.publicCode === incomplete.code && detail.status === 'REGISTRATION_OPEN');
    check('public detail returns exactly the safe field allowlist',
      detail !== null && JSON.stringify(Object.keys(detail).sort()) === JSON.stringify(expectedPublicKeys));
    check('public projection omits private policy/session/audit/identity fields',
      detail !== null && privateNames.every((name) => !Object.hasOwn(detail, name)));
    const openList = await publicReads.listOpen();
    check('public list includes the open publication and no non-open statuses',
      openList.some((item) => item.publicCode === incomplete.code) &&
      openList.every((item) => item.status === 'REGISTRATION_OPEN'));
    const publicRoleCannotReadPolicy = await (async () => {
      try {
        await sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE usrp_campaign_public_reader`;
          await tx`SELECT policy_hash FROM public_core.campaign_policy_versions WHERE campaign_id = ${incomplete.campaignId}::uuid`;
        });
        return false;
      } catch {
        return true;
      }
    })();
    check('public-reader database role cannot select private policy hashes', publicRoleCannotReadPolicy);

    console.log('\n── P11. Concurrent publication is serialized and idempotent ───');
    const concurrentSame = await createReadyCampaign('CONCURRENT-SAME-KEY');
    const sharedPublishRequest = commandRequest(RDF_ACTOR, { publicCode: concurrentSame.code });
    const sameKeyRace = await Promise.allSettled([
      campaign.publish(sharedPublishRequest),
      campaign.publish(sharedPublishRequest),
    ]);
    const sameKeyResults = sameKeyRace.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    check('concurrent same-key publication has one original and one replay',
      sameKeyResults.length === 2 && sameKeyResults.filter((item) => !item.replayed).length === 1 &&
      sameKeyResults.filter((item) => item.replayed).length === 1 &&
      sameKeyResults[0]?.commandId === sameKeyResults[1]?.commandId);
    check('same-key publication race creates one publication fact',
      await countForCampaign('campaign_publications', concurrentSame.campaignId) === 1);

    const concurrentDistinct = await createReadyCampaign('CONCURRENT-DISTINCT-KEYS');
    const distinctRequestA = commandRequest(RDF_ACTOR, { publicCode: concurrentDistinct.code });
    const distinctRequestB = commandRequest(RDF_ACTOR, { publicCode: concurrentDistinct.code });
    const distinctRace = await Promise.allSettled([
      campaign.publish(distinctRequestA),
      campaign.publish(distinctRequestB),
    ]);
    const distinctSuccesses = distinctRace.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const distinctFailures = distinctRace.filter((result) => result.status === 'rejected');
    check('different-key concurrent publication commits exactly once',
      distinctSuccesses.length === 1 && distinctFailures.length === 1 &&
      distinctFailures.every((result) => result.status === 'rejected' &&
        result.reason instanceof CampaignCommandError && result.reason.code === 'INVALID_STATE'));
    check('different-key publication race has one publication row',
      await countForCampaign('campaign_publications', concurrentDistinct.campaignId) === 1);

    console.log('\n── P12. Publication/session-write race uses campaign-first locking ─');
    const sessionRaceCampaign = await createReadyCampaign('PUBLICATION-SESSION-RACE');
    const changedSessionRequest = commandRequest(
      RDF_ACTOR,
      sessionBody(sessionRaceCampaign.code, TARGETS[0], 'RACE-UPDATED-VENUE'),
    );
    const sessionRace = await Promise.allSettled([
      campaign.publish(commandRequest(RDF_ACTOR, { publicCode: sessionRaceCampaign.code })),
      campaignSessions.configure(changedSessionRequest),
    ]);
    const racePublication = sessionRace[0];
    const raceSession = sessionRace[1];
    const finalCoverage = await coverageState(sessionRaceCampaign.campaignId);
    const raceEvidence = await admin<{ coverage_version: number; coverage_hash: string }[]>`
      SELECT coverage_version, coverage_hash FROM public_core.campaign_publications
      WHERE campaign_id = ${sessionRaceCampaign.campaignId}::uuid`;
    check('publication/session race always publishes one coherent campaign',
      racePublication.status === 'fulfilled' && await countForCampaign('campaign_publications', sessionRaceCampaign.campaignId) === 1);
    check('publication evidence matches the post-lock session set',
      raceEvidence[0]?.coverage_version === finalCoverage.version &&
      raceEvidence[0]?.coverage_hash === finalCoverage.computedHash &&
      finalCoverage.hash === finalCoverage.computedHash);
    check('session mutation either commits before publication or is rejected after it',
      (raceSession.status === 'fulfilled' && raceSession.value.changed && finalCoverage.version === 3) ||
      (raceSession.status === 'rejected' && raceSession.reason instanceof CampaignSessionCommandError &&
        raceSession.reason.code === 'INVALID_STATE' && finalCoverage.version === 2));

    console.log('\n── P13. Publication/registration-close race preserves legal edges ─');
    const closeRaceCampaign = await createReadyCampaign('PUBLICATION-CLOSE-RACE');
    const pubRaceRequest = commandRequest(RDF_ACTOR, { publicCode: closeRaceCampaign.code });
    const closeRace = await Promise.allSettled([
      campaign.publish(pubRaceRequest),
      campaign.closeRegistration(commandRequest(RDF_ACTOR, { publicCode: closeRaceCampaign.code })),
    ]);
    const closeRaceRow = await campaignRow(closeRaceCampaign.code);
    const closeSucceeded = closeRace[1]?.status === 'fulfilled';
    check('publication/close race always commits a publication first',
      closeRace[0]?.status === 'fulfilled' && await countForCampaign('campaign_publications', closeRaceCampaign.campaignId) === 1);
    check('close either follows publication or fails against DRAFT; final state is legal',
      (closeSucceeded && closeRaceRow?.status === 'REGISTRATION_CLOSED') ||
      (!closeSucceeded && closeRaceRow?.status === 'REGISTRATION_OPEN'));
    if (closeRace[1]?.status === 'rejected') {
      check('close-before-publication reports INVALID_STATE',
        closeRace[1].reason instanceof CampaignCommandError && closeRace[1].reason.code === 'INVALID_STATE');
    }
    const externallyPublishedClose = await publicReads.findPublishedByCode(closeRaceCampaign.code);
    check('externally published detail remains available after close',
      externallyPublishedClose?.status === closeRaceRow?.status);
    check('closed/cancelled campaigns are not in the open-only list',
      closeRaceRow?.status !== 'REGISTRATION_CLOSED' ||
      !(await publicReads.listOpen()).some((item) => item.publicCode === closeRaceCampaign.code));

    console.log('\n── P14. Invalid transitions and permitted cancellation ───────');
    const directOpenCode = publicCode('DIRECT-OPEN');
    await expectPgRejected('database rejects direct insertion of a non-DRAFT campaign state', () => admin`
      INSERT INTO public_core.recruitment_campaigns
        (campaign_label, agency, public_code, status, target_categories, target_districts,
         registration_opens_at, registration_closes_at, examination_start_date,
         examination_end_date, examination_reporting_hour, allows_walk_in)
      VALUES (
        ${`${PREFIX} direct open`}, 'RDF', ${directOpenCode}, 'REGISTRATION_OPEN',
        '["GENERAL_ENLISTMENT"]', '["GASABO"]'::jsonb,
        '2030-01-01T08:00:00+02:00'::timestamptz,
        '2030-01-31T17:00:00+02:00'::timestamptz,
        '2030-02-01', '2030-02-15', 8, false
      )`, /new campaigns must begin as a complete DRAFT/);
    const missingHistoryCode = publicCode('MISSING-INITIAL-HISTORY');
    await expectPgRejected('database requires an initial DRAFT history row at commit', () => admin.begin((tx) => tx`
      INSERT INTO public_core.recruitment_campaigns
        (campaign_label, agency, public_code, status, target_categories, target_districts,
         registration_opens_at, registration_closes_at, examination_start_date,
         examination_end_date, examination_reporting_hour, allows_walk_in)
      VALUES (
        ${`${PREFIX} missing history`}, 'RDF', ${missingHistoryCode}, 'DRAFT',
        '["GENERAL_ENLISTMENT"]', '["GASABO"]'::jsonb,
        '2030-01-01T08:00:00+02:00'::timestamptz,
        '2030-01-31T17:00:00+02:00'::timestamptz,
        '2030-02-01', '2030-02-15', 8, false
      )`), /initial DRAFT history row/);
    const uncommittedPublication = await createReadyCampaign('DRAFT-PUBLICATION-FACT');
    const publicationInputs = await admin<{
      policy_version_id: string;
      coverage_version: number;
      coverage_hash: string;
    }[]>`
      SELECT c.current_policy_version_id AS policy_version_id,
             h.coverage_version, h.coverage_hash
      FROM public_core.recruitment_campaigns c
      JOIN public_core.campaign_coverage_heads h ON h.campaign_id = c.id
      WHERE c.id = ${uncommittedPublication.campaignId}::uuid`;
    const publicationInput = publicationInputs[0];
    if (publicationInput === undefined) throw new Error('Missing draft publication fixture state.');
    await expectPgRejected('database rejects a publication fact without a published campaign state', () => admin.begin((tx) => tx`
      INSERT INTO public_core.campaign_publications
        (campaign_id, agency, public_code, policy_version_id, coverage_version,
         coverage_hash, publication_event_id, published_by)
      VALUES (
        ${uncommittedPublication.campaignId}::uuid, 'RDF', ${uncommittedPublication.code},
        ${publicationInput.policy_version_id}::uuid, ${publicationInput.coverage_version},
        ${publicationInput.coverage_hash}, ${randomUUID()}::uuid, ${RDF_ACTOR.subjectId}::uuid
      )`), /publication fact requires a publicly published campaign state/);
    check('failed draft publication fact remains hidden from public detail',
      await publicReads.findPublishedByCode(uncommittedPublication.code) === null);

    const transitionDraft = await createDraft('INVALID-TRANSITION');
    await createPolicy(transitionDraft.code);
    await expectCode('DRAFT cannot close registration before publication', () =>
      campaign.closeRegistration(commandRequest(RDF_ACTOR, { publicCode: transitionDraft.code })),
    'INVALID_STATE');
    await expectCode('DRAFT cannot complete before registration closes', () =>
      campaign.complete(commandRequest(RDF_ACTOR, { publicCode: transitionDraft.code })),
    'INVALID_STATE');
    await expectPgRejected('database rejects direct DRAFT → REGISTRATION_CLOSED update', () =>
      admin`UPDATE public_core.recruitment_campaigns SET status = 'REGISTRATION_CLOSED' WHERE id = ${transitionDraft.campaignId}::uuid`,
    /illegal campaign lifecycle transition/);
    check('invalid transition leaves campaign a draft', (await campaignRow(transitionDraft.code))?.status === 'DRAFT');

    const draftCancellation = await createDraft('DRAFT-CANCEL');
    await campaign.cancel(commandRequest(RDF_ACTOR, { publicCode: draftCancellation.code }));
    check('DRAFT → CANCELLED is a permitted lifecycle edge',
      (await campaignRow(draftCancellation.code))?.status === 'CANCELLED');
    await expectCode('cancelled campaign cannot be republished', () =>
      campaign.publish(commandRequest(RDF_ACTOR, { publicCode: draftCancellation.code })),
    'INVALID_STATE');

    const openCancellation = await createReadyCampaign('OPEN-CANCEL');
    await campaign.publish(commandRequest(RDF_ACTOR, { publicCode: openCancellation.code }));
    await campaign.cancel(commandRequest(RDF_ACTOR, { publicCode: openCancellation.code }));
    check('REGISTRATION_OPEN → CANCELLED is allowed when no application exists',
      (await campaignRow(openCancellation.code))?.status === 'CANCELLED');
    check('cancelled external detail remains published but is not listed as open',
      (await publicReads.findPublishedByCode(openCancellation.code))?.status === 'CANCELLED' &&
      !(await publicReads.listOpen()).some((item) => item.publicCode === openCancellation.code));
    let lateSubmissionError: unknown;
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_system_service`;
        await insertSubmittedApplication(tx, AGENCY_TARGET.RDF, {
          agency: 'RDF',
          applicantId: randomUUID(),
          campaignId: openCancellation.campaignId,
          category: 'GENERAL_ENLISTMENT',
          nesaIndexNumber: null,
          hecRegistrationNumber: null,
        });
      });
    } catch (error) {
      lateSubmissionError = error;
    }
    check('application insert that reaches the row lock after cancellation is refused',
      lateSubmissionError instanceof CampaignUnavailableForApplicationError);

    const registrationClosed = await createReadyCampaign('CLOSED-SUBMISSION');
    await campaign.publish(commandRequest(RDF_ACTOR, { publicCode: registrationClosed.code }));
    await campaign.closeRegistration(commandRequest(RDF_ACTOR, { publicCode: registrationClosed.code }));
    let lateClosedSubmissionError: unknown;
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE usrp_system_service`;
        await insertSubmittedApplication(tx, AGENCY_TARGET.RDF, {
          agency: 'RDF',
          applicantId: randomUUID(),
          campaignId: registrationClosed.campaignId,
          category: 'GENERAL_ENLISTMENT',
          nesaIndexNumber: null,
          hecRegistrationNumber: null,
        });
      });
    } catch (error) {
      lateClosedSubmissionError = error;
    }
    check('digital submission that reaches the campaign lock after close is refused',
      lateClosedSubmissionError instanceof CampaignUnavailableForApplicationError);

    const cancellationRace = await createReadyCampaign('CANCEL-SUBMISSION-RACE');
    await campaign.publish(commandRequest(RDF_ACTOR, { publicCode: cancellationRace.code }));
    const raceApplicantId = await createTestApplicantIdentity();
    let signalAppWrite!: () => void;
    let rejectAppWrite!: (error: unknown) => void;
    const appWriteReady = new Promise<void>((resolvePromise, rejectPromise) => {
      signalAppWrite = resolvePromise;
      rejectAppWrite = rejectPromise;
    });
    let releaseAppWrite!: () => void;
    const releaseGate = new Promise<void>((resolvePromise) => { releaseAppWrite = resolvePromise; });
    const submissionTask = sql.begin(async (tx) => {
      try {
        await tx`SET LOCAL ROLE usrp_system_service`;
        const inserted = await insertSubmittedApplication(tx, AGENCY_TARGET.RDF, {
          agency: 'RDF',
          applicantId: raceApplicantId,
          campaignId: cancellationRace.campaignId,
          category: 'GENERAL_ENLISTMENT',
          nesaIndexNumber: null,
          hecRegistrationNumber: null,
        });
        await insertOpeningHistory(tx, AGENCY_TARGET.RDF, inserted.applicationId, randomUUID());
        signalAppWrite();
        await releaseGate;
        return inserted;
      } catch (error) {
        rejectAppWrite(error);
        throw error;
      }
    }).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    await appWriteReady;
    const cancellationTask = campaign.cancel(commandRequest(RDF_ACTOR, { publicCode: cancellationRace.code })).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 30));
    releaseAppWrite();
    const [submissionRaceResult, cancellationRaceResult] = await Promise.all([submissionTask, cancellationTask]);
    const raceApplicationCount = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM rdf_ops.applications
      WHERE campaign_id = ${cancellationRace.campaignId}::uuid`;
    check('in-flight application holds a shared campaign lock until its insert commits',
      submissionRaceResult.status === 'fulfilled');
    check('cancellation waits, then rejects after the application commits',
      cancellationRaceResult.status === 'rejected' &&
      cancellationRaceResult.reason instanceof CampaignCommandError &&
      cancellationRaceResult.reason.code === 'CANCELLATION_HAS_APPLICATIONS' &&
      (await campaignRow(cancellationRace.code))?.status === 'REGISTRATION_OPEN');
    check('cancellation/submission race never commits a cancelled campaign with an application',
      raceApplicationCount[0]?.n === 1 && (await campaignRow(cancellationRace.code))?.status === 'REGISTRATION_OPEN');

    const applicationCancellation = await createReadyCampaign('OPEN-CANCEL-WITH-APPLICATION');
    await campaign.publish(commandRequest(RDF_ACTOR, { publicCode: applicationCancellation.code }));
    await insertApplication(applicationCancellation.campaignId);
    await expectCode('open campaign with an application cannot be cancelled', () =>
      campaign.cancel(commandRequest(RDF_ACTOR, { publicCode: applicationCancellation.code })),
    'CANCELLATION_HAS_APPLICATIONS');
    check('blocked cancellation leaves registration open',
      (await campaignRow(applicationCancellation.code))?.status === 'REGISTRATION_OPEN');

    console.log('\n── P15. Publication, outbox, and audit commit atomically ──────');
    const atomic = await createReadyCampaign('ATOMIC-PUBLICATION');
    const atomicKey = randomUUID();
    const atomicCommand: CampaignControlCommand = {
      operation: 'PUBLISH',
      actor: RDF_ACTOR,
      idempotencyKey: atomicKey,
      requestHash: hashCampaignCanonicalJson({ operation: 'PUBLISH', publicCode: atomic.code }),
      publicCode: atomic.code,
      context: { correlationId: randomUUID() },
    };
    let stageWasCalled = false;
    let stageFailure: unknown;
    try {
      await repository.execute(atomicCommand, () => {
        stageWasCalled = true;
        // The DB command function validates this exact event set after it has
        // attempted aggregate writes; an empty set forces transactional rollback.
        return [];
      });
    } catch (error) {
      stageFailure = error;
    }
    check('invalid event set reaches the database command validator', stageWasCalled);
    check('database event validation aborts the publication transaction',
      stageFailure instanceof CampaignCommandError && stageFailure.code === 'CAMPAIGN_WRITE_CONFLICT');
    const publishRequestsAfterAbort = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public_core.campaign_command_requests
      WHERE actor_id = ${RDF_ACTOR.subjectId}::uuid
        AND operation = 'publishCampaign'
        AND idempotency_key = ${atomicKey}::uuid`;
    check('failed transaction leaves no publication, command, or lifecycle edge',
      (await campaignRow(atomic.code))?.status === 'DRAFT' &&
      await countForCampaign('campaign_publications', atomic.campaignId) === 0 &&
      await countForCampaign('campaign_lifecycle_history', atomic.campaignId) === 1 &&
      publishRequestsAfterAbort[0]?.n === 0);
    check('failed outbox stage leaves prior campaign outbox rows unchanged',
      (await outboxForCampaign(atomic.campaignId)).length === 8);
    const atomicPublished = await campaign.publish(commandRequest(RDF_ACTOR, { publicCode: atomic.code }, atomicKey));
    check('same idempotency key can succeed after the rolled-back attempt',
      !atomicPublished.replayed && (await campaignRow(atomic.code))?.status === 'REGISTRATION_OPEN');
    const atomicOutbox = await outboxForCampaign(atomic.campaignId);
    const atomicAudits = atomicOutbox.filter((row) => row.event_type === 'AUDIT_ENTRY');
    const atomicDomainEvents = atomicOutbox.filter((row) => row.event_type !== 'AUDIT_ENTRY');
    const safeEvents = atomicOutbox.every((row) => {
      const payload = row.payload as Record<string, unknown>;
      return payload['schemaVersion'] === '1.0' && payload['piiClassification'] === 'NONE' &&
        typeof payload['correlationId'] === 'string' && typeof payload['causationId'] === 'string';
    });
    const safeAudits = atomicAudits.every((row) => {
      const payload = row.payload as Record<string, unknown>;
      const metadata = payload['metadata'];
      const fields = metadata !== null && typeof metadata === 'object'
        ? Object.keys(metadata as Record<string, unknown>)
        : [];
      const metadataObject = metadata !== null && typeof metadata === 'object'
        ? metadata as Record<string, unknown>
        : {};
      const capacityDecision = metadataObject['capacityDecisionCode'];
      return !fields.some((field) => /policyDocument|policyHash|threshold|capacityLimit|registeredCount|officer/i.test(field)) &&
        (capacityDecision === undefined || capacityDecision === null || capacityDecision === 'UNBOUNDED_CAPACITY');
    });
    check('successful commands persist one safe AUDIT_ENTRY each', atomicAudits.length === 5 && safeAudits);
    check('draft, policy, sessions, and publication each stage their domain event',
      atomicDomainEvents.filter((row) => row.event_type === 'CAMPAIGN_DRAFT_CREATED').length === 1 &&
      atomicDomainEvents.filter((row) => row.event_type === 'CAMPAIGN_POLICY_VERSION_CREATED').length === 1 &&
      atomicDomainEvents.filter((row) => row.event_type === 'CAMPAIGN_SESSION_CONFIGURED').length === 2 &&
      atomicDomainEvents.filter((row) => row.event_type === 'CAMPAIGN_PUBLISHED').length === 1);
    check('no duplicate publication/audit event was created by retry',
      atomicAudits.length === 5 && atomicDomainEvents.filter((row) => row.event_type === 'CAMPAIGN_PUBLISHED').length === 1);
    const atomicReplay = await campaign.publish(commandRequest(RDF_ACTOR, { publicCode: atomic.code }, atomicKey));
    check('publication retry returns the stored result without staging events',
      atomicReplay.replayed && atomicReplay.commandId === atomicPublished.commandId &&
      (await outboxForCampaign(atomic.campaignId)).length === atomicOutbox.length);

    console.log('\n── P16. Durable lifecycle events and replay identity ──────────');
    const closeTarget = await createReadyCampaign('LIFECYCLE-EVENTS');
    const closePublish = await campaign.publish(commandRequest(RDF_ACTOR, { publicCode: closeTarget.code }));
    const closeRequest = commandRequest(RDF_ACTOR, { publicCode: closeTarget.code });
    const closeResult = await campaign.closeRegistration(closeRequest);
    const outboxAfterClose = await outboxForCampaign(closeTarget.campaignId);
    const closeReplay = await campaign.closeRegistration(closeRequest);
    const outboxAfterCloseReplay = await outboxForCampaign(closeTarget.campaignId);
    const completionRequest = commandRequest(RDF_ACTOR, { publicCode: closeTarget.code });
    const completionResult = await campaign.complete(completionRequest);
    const outboxAfterCompletion = await outboxForCampaign(closeTarget.campaignId);
    const completionReplay = await campaign.complete(completionRequest);
    const lifecycleOutbox = await outboxForCampaign(closeTarget.campaignId);
    const publicationEvent = lifecycleOutbox.find((row) => row.event_type === 'CAMPAIGN_PUBLISHED');
    const closeEvent = lifecycleOutbox.find((row) => row.event_type === 'CAMPAIGN_REGISTRATION_CLOSED');
    const completedEvent = lifecycleOutbox.find((row) => row.event_type === 'CAMPAIGN_COMPLETED');
    const completedPayload = completedEvent?.payload as Record<string, unknown> | undefined;
    const completedHistoryId = completedPayload?.['lifecycleHistoryId'];
    const expectedCompletedEventId = typeof completedHistoryId === 'string'
      ? campaignFactUuid(
        'c6c2ef80-2ef0-4eeb-b6a4-4f93d5a4ac11',
        `completed:${completedHistoryId}`,
      )
      : null;
    const completionHistory = await admin<{ from_status: string; to_status: string }[]>`
      SELECT from_status, to_status FROM public_core.campaign_lifecycle_history
      WHERE campaign_id = ${closeTarget.campaignId}::uuid
      ORDER BY occurred_at DESC, id DESC LIMIT 1`;
    check('publication, close, and completion emit stable event identities per immutable fact',
      publicationEvent !== undefined && closeEvent !== undefined && completedEvent !== undefined &&
      closePublish.fact?.kind === 'PUBLISHED' && closeResult.fact?.kind === 'REGISTRATION_CLOSED' &&
      completionResult.fact?.kind === 'COMPLETED' && completedEvent.event_id === expectedCompletedEventId);
    check('close replay returns the stored history result without another event',
      closeReplay.replayed && closeReplay.commandId === closeResult.commandId &&
      outboxAfterCloseReplay.length === outboxAfterClose.length);
    check('REGISTRATION_CLOSED → COMPLETED is service-enforced and persisted',
      (await campaignRow(closeTarget.code))?.status === 'COMPLETED' &&
      completionHistory[0]?.from_status === 'REGISTRATION_CLOSED' &&
      completionHistory[0]?.to_status === 'COMPLETED');
    check('completed campaign remains addressable but is absent from the open-only list',
      (await publicReads.findPublishedByCode(closeTarget.code))?.status === 'COMPLETED' &&
      !(await publicReads.listOpen()).some((item) => item.publicCode === closeTarget.code));
    check('completion replay returns its stored result without another domain/audit event',
      completionReplay.replayed && completionReplay.commandId === completionResult.commandId &&
      lifecycleOutbox.length === outboxAfterCompletion.length);
    check('event payload carries schema/correlation/causation and no PII classification',
      lifecycleOutbox.every((row) => {
        const payload = row.payload as Record<string, unknown>;
        return payload['schemaVersion'] === '1.0' && payload['piiClassification'] === 'NONE' &&
          typeof payload['correlationId'] === 'string' && typeof payload['causationId'] === 'string';
      }));

    console.log('\n── P17. Legacy migration and submission compatibility ────────');
    const migration = readFileSync(resolve(
      REPO_ROOT,
      'packages/shared-database/src/migrations/0002_campaign_control_plane.sql',
    ), 'utf8');
    const bootstrap = readFileSync(resolve(REPO_ROOT, 'scripts/bootstrap-db.sh'), 'utf8');
    check('exact 0002 migration backfills legacy public codes deterministically',
      migration.includes("'LEGACY-' || upper(replace(\"id\"::text, '-', ''))"));
    check('legacy target districts derive from existing venues and remain NULL if unknown',
      migration.includes('jsonb_agg(v."district" ORDER BY v."district")') &&
      migration.includes('WHERE c."target_districts" IS NULL') &&
      migration.includes('AND EXISTS ('));
    check('migration does not rewrite legacy campaign statuses or drop old session data',
      !/UPDATE\s+"public_core"\."recruitment_campaigns"\s+SET\s+"status"/i.test(migration) &&
      !/DROP\s+(TABLE|COLUMN).*campaign_venue_assignments/i.test(migration));
    check('bootstrap applies RLS 0026 after RLS 0025',
      bootstrap.indexOf('0025_') >= 0 && bootstrap.indexOf('0026_campaign_control_plane.sql') > bootstrap.indexOf('0025_'));
    check('legacy EXAMINATION_ACTIVE enum value remains available',
      migration.includes('campaign_status') &&
      (await admin<{ value: string }[]>`
        SELECT unnest(enum_range(NULL::public_core.campaign_status))::text AS value`
      ).some((row) => row.value === 'EXAMINATION_ACTIVE'));

    const legacyId = randomUUID();
    const legacyCode = `LEGACY-${legacyId.replaceAll('-', '').toUpperCase()}`;
    legacyPublicCode = legacyCode;
    await admin.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        INSERT INTO public_core.recruitment_campaigns
          (id, campaign_label, agency, public_code, status, target_categories,
           target_districts, registration_opens_at, registration_closes_at,
           examination_start_date, examination_end_date, examination_reporting_hour,
           allows_walk_in)
        VALUES (
          ${legacyId}::uuid, ${`${PREFIX} legacy submission`} , 'RNP', ${legacyCode},
          'REGISTRATION_OPEN', '["CADET_OFFICER"]', NULL,
          now() - interval '1 second', now() + interval '1 day',
          '2030-02-01', '2030-02-15', 8, false
        )`;
      await tx`
        INSERT INTO public_core.campaign_venue_assignments
          (campaign_id, district, province, venue_name, exam_date,
           reporting_time_hour, capacity_limit, registered_count, is_active)
        VALUES (
          ${legacyId}::uuid, 'GASABO', 'KIGALI_CITY', 'Legacy venue remains',
          '2030-02-03', 8, 20, 1, true
        )`;
    });
    const legacyRead = await new PgCampaignReader().findOpenCampaign('RNP', 'CADET_OFFICER');
    const legacyVenue = await admin<{ n: number; registered_count: number }[]>`
      SELECT count(*)::int AS n, max(registered_count)::int AS registered_count
      FROM public_core.campaign_venue_assignments WHERE campaign_id = ${legacyId}::uuid`;
    check('legacy submission reader still resolves an open campaign without a publication row',
      legacyRead?.campaignId === legacyId && await publicReads.findPublishedByCode(legacyCode) === null);
    check('legacy session row and capacity count survive alongside NULL legacy districts',
      legacyVenue[0]?.n === 1 && legacyVenue[0]?.registered_count === 1 &&
      (await admin<{ target_districts: unknown }[]>`
        SELECT target_districts FROM public_core.recruitment_campaigns WHERE id = ${legacyId}::uuid`
      )[0]?.target_districts === null);

  } finally {
    await cleanup();
    await Promise.all([sql.end(), admin.end()]);
  }

  console.log('\n───────────────────────────────────────────────');
  if (failures === 0) console.log('BUILD-001 CAMPAIGN CONTROL PLANE P5–P17 PASSED ✓');
  else {
    console.error(`${failures} ASSERTION(S) FAILED ✗`);
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error('\nCAMPAIGN CONTROL-PLANE PROOF CRASHED:', error);
  process.exitCode = 1;
});
