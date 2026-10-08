// BUILD-001 P5–P17 and adversarial database proofs. Requires the bootstrapped
// Tier-1 PostgreSQL database. This exercises the real application/scheduling
// services and repositories through officer DB roles, not transaction mocks.

import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { Principal } from '@usrp/shared-auth';
import { sql } from '@usrp/shared-database';
import { campaignCoverageHash, campaignFactUuid, hashCampaignCanonicalJson } from '@usrp/shared-security';
import type { CampaignControlCommand } from '../src/ports/campaign-control.repository.js';
import { CampaignControlService } from '../src/application/campaign-control.service.js';
import { PgCampaignControlRepository } from '../src/adapters/campaign-control.pg-repository.js';
import { PgCampaignPublicReadRepository } from '../src/adapters/campaign-public-read.pg-repository.js';
import { CampaignCommandError, CampaignPersistenceError } from '../src/domain/campaign-control.errors.js';
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

const repository = new PgCampaignControlRepository();
const campaign = new CampaignControlService({ repository });
const campaignSessions = new CampaignSessionService(new PgCampaignSessionRepository());
const publicReads = new PgCampaignPublicReadRepository();

let failures = 0;
const applicantIds: string[] = [];
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

async function main(): Promise<void> {
  try {
    await cleanup();
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
    await campaignSessions.configure(commandRequest(
      RDF_ACTOR,
      sessionBody(incomplete.code, TARGETS[0], 'INCOMPLETE-GASABO'),
    ));
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
        throw new Error('synthetic outbox staging failure');
      });
    } catch (error) {
      stageFailure = error;
    }
    check('synthetic outbox failure is reached after campaign writes are staged', stageWasCalled);
    check('outbox failure aborts the publication transaction', stageFailure instanceof CampaignPersistenceError);
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
      return !fields.some((field) => /policyDocument|policyHash|threshold|capacity|officer/i.test(field));
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
