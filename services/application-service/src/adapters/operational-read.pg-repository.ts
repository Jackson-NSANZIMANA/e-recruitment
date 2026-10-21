// ══════════════════════════════════════════════════════════════════
// application-service — OperationalReadRepository adapter (PostgreSQL, ADR-039)
//
// Everything runs in ONE transaction AS THE OFFICER'S AGENCY ROLE, so a
// sibling agency's rows are not filtered out by this code but by FORCE'd RLS
// and by the role having no grant on the sibling ops schema. Agency is also
// repeated in the WHERE clause as belt and braces.
//
// NO WRITE of any kind. rls/0035 adds indexes only.
//
// Timestamps used for keyset ordering are read back as microsecond UTC TEXT
// (never a JS Date), so the cursor round-trips exactly.
// ══════════════════════════════════════════════════════════════════

import { sql, type SqlTransaction } from '@usrp/shared-database';
import type { ApplicationStatus, CampaignStatus, DocumentType } from '@usrp/shared-types';
import { ApplicationReadError } from '../domain/application.errors.js';
import { schemaForAgency } from '../domain/agency-schema.js';
import { resolveRequiredDocuments } from '../domain/document-requirements.js';
import {
  MAX_ROSTER_ROWS,
  type ApplicationSearch,
  type CampaignAdminSearch,
  type RosterQuery,
} from '../domain/operational-reads.js';
import type {
  AgencyScope,
  ApplicationSearchPage,
  CampaignAdminDetail,
  CampaignAdminPage,
  CampaignAdminSummary,
  CampaignSessionOccupancy,
  OperationalReadRepository,
  RosterEntry,
  VenueRoster,
} from '../ports/operational-read-repository.js';

type Timestamptz = Date | string;
const iso = (v: Timestamptz): string => new Date(v).toISOString();
const isoOrNull = (v: Timestamptz | null): string | null => (v === null ? null : iso(v));

/** The one timestamp format the cursor carries. */
const SORT_KEY_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

function jsonStrings(value: unknown): readonly string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

async function asOfficer<T>(scope: AgencyScope, run: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ${sql(scope.dbRole)}`;
    return run(tx);
  });
  return result as T;
}

// ── applications ───────────────────────────────────────────────────
interface ApplicationRow {
  readonly id: string;
  readonly processing_code: string;
  readonly category: string;
  readonly status: ApplicationStatus;
  readonly submitted_at: Date | null;
  readonly sort_key: string;
}

// ── campaigns ──────────────────────────────────────────────────────
interface CampaignRow {
  readonly id: string;
  readonly public_code: string;
  readonly campaign_label: string;
  readonly status: CampaignStatus;
  readonly target_categories: string;
  readonly target_districts: unknown;
  readonly registration_opens_at: Timestamptz;
  readonly registration_closes_at: Timestamptz;
  readonly examination_start_date: string;
  readonly examination_end_date: string;
  readonly allows_walk_in: boolean;
  readonly target_intake_count: number | null;
  readonly published_at: Timestamptz | null;
  readonly created_at: Timestamptz;
  readonly sort_key: string;
  readonly session_count: number | string;
  readonly capacity_total: number | string | null;
  readonly has_unbounded: boolean;
  readonly registered_total: number | string;
}

function toSummary(row: CampaignRow): CampaignAdminSummary {
  return {
    publicCode: row.public_code,
    campaignLabel: row.campaign_label,
    status: row.status,
    targetCategories: jsonStrings(row.target_categories),
    targetDistricts: jsonStrings(row.target_districts),
    registrationOpensAt: iso(row.registration_opens_at),
    registrationClosesAt: iso(row.registration_closes_at),
    examinationStartDate: row.examination_start_date,
    examinationEndDate: row.examination_end_date,
    allowsWalkIn: row.allows_walk_in,
    targetIntakeCount: row.target_intake_count,
    publishedAt: isoOrNull(row.published_at),
    createdAt: iso(row.created_at),
    occupancy: {
      sessionCount: Number(row.session_count),
      capacityTotal: row.capacity_total === null ? null : Number(row.capacity_total),
      hasUnboundedSession: row.has_unbounded,
      registeredTotal: Number(row.registered_total),
    },
  };
}

/** The columns every campaign read selects, plus the session occupancy roll-up. */
function campaignSelect(tx: SqlTransaction): ReturnType<SqlTransaction> {
  return tx`
    c.id, c.public_code, c.campaign_label, c.status::text AS status,
    c.target_categories, c.target_districts,
    c.registration_opens_at, c.registration_closes_at,
    c.examination_start_date, c.examination_end_date,
    c.allows_walk_in, c.target_intake_count, c.published_at, c.created_at,
    to_char(c.created_at AT TIME ZONE 'UTC', ${SORT_KEY_FORMAT}) AS sort_key,
    COALESCE(v.session_count, 0) AS session_count,
    v.capacity_total, COALESCE(v.has_unbounded, false) AS has_unbounded,
    COALESCE(v.registered_total, 0) AS registered_total`;
}

function campaignFrom(tx: SqlTransaction): ReturnType<SqlTransaction> {
  return tx`
    public_core.recruitment_campaigns c
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE a.is_active) AS session_count,
             sum(a.capacity_limit) AS capacity_total,
             bool_or(a.capacity_limit IS NULL) AS has_unbounded,
             COALESCE(sum(a.registered_count), 0) AS registered_total
      FROM public_core.campaign_venue_assignments a
      WHERE a.campaign_id = c.id
    ) v ON true`;
}

export class PgOperationalReadRepository implements OperationalReadRepository {
  async searchApplications(scope: AgencyScope, search: ApplicationSearch): Promise<ApplicationSearchPage> {
    const schema = sql(schemaForAgency(scope.agency));
    try {
      return await asOfficer(scope, async (tx) => {
        const statusFilter = search.statuses.length === 0
          ? tx``
          : tx`AND a.status::text = ANY(${[...search.statuses]}::text[])`;
        const categoryFilter = search.category === null ? tx`` : tx`AND a.category::text = ${search.category}`;
        const campaignFilter = search.campaignPublicCode === null
          ? tx``
          : tx`AND a.campaign_id = (SELECT c.id FROM public_core.recruitment_campaigns c WHERE c.public_code = ${search.campaignPublicCode} AND c.agency = ${scope.agency}::public_core.agency)`;
        const districtFilter = search.district === null ? tx`` : tx`AND a.assigned_district = ${search.district}`;
        const fromFilter = search.submittedFrom === null
          ? tx``
          : tx`AND a.submitted_at >= ((${search.submittedFrom}::date)::timestamp AT TIME ZONE 'Africa/Kigali')`;
        const toFilter = search.submittedTo === null
          ? tx``
          : tx`AND a.submitted_at < (((${search.submittedTo}::date + 1))::timestamp AT TIME ZONE 'Africa/Kigali')`;
        const filters = tx`${statusFilter} ${categoryFilter} ${campaignFilter} ${districtFilter} ${fromFilter} ${toFilter}`;
        const cursorFilter = search.cursor === null
          ? tx``
          : tx`AND (COALESCE(a.submitted_at, a.created_at), a.id) < (${search.cursor.sortKey}::timestamptz, ${search.cursor.id}::uuid)`;

        const totals = await tx<{ total: string }[]>`
          SELECT count(*)::text AS total FROM ${schema}.applications a WHERE true ${filters}`;
        const rows = await tx<ApplicationRow[]>`
          SELECT a.id, a.processing_code, a.category::text AS category, a.status::text AS status, a.submitted_at,
                 to_char(COALESCE(a.submitted_at, a.created_at) AT TIME ZONE 'UTC', ${SORT_KEY_FORMAT}) AS sort_key
          FROM ${schema}.applications a
          WHERE true ${filters} ${cursorFilter}
          ORDER BY COALESCE(a.submitted_at, a.created_at) DESC, a.id DESC
          LIMIT ${search.limit + 1}`;
        const page = rows.slice(0, search.limit);
        return {
          total: Number(totals[0]?.total ?? '0'),
          hasMore: rows.length > search.limit,
          rows: page.map((r) => ({
            applicationId: r.id,
            processingCode: r.processing_code,
            category: r.category,
            status: r.status,
            submittedAt: isoOrNull(r.submitted_at),
            sortKey: r.sort_key,
          })),
        };
      });
    } catch (cause) {
      throw new ApplicationReadError('Could not search applications for the agency.', { cause });
    }
  }

  async listCampaigns(scope: AgencyScope, search: CampaignAdminSearch): Promise<CampaignAdminPage> {
    try {
      return await asOfficer(scope, async (tx) => {
        const statusFilter = search.statuses.length === 0
          ? tx``
          : tx`AND c.status::text = ANY(${[...search.statuses]}::text[])`;
        const like = search.text === null ? null : `%${search.text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        const textFilter = like === null
          ? tx``
          : tx`AND (c.campaign_label ILIKE ${like} OR c.public_code ILIKE ${like})`;
        const filters = tx`AND c.agency = ${scope.agency}::public_core.agency ${statusFilter} ${textFilter}`;
        const cursorFilter = search.cursor === null
          ? tx``
          : tx`AND (c.created_at, c.id) < (${search.cursor.sortKey}::timestamptz, ${search.cursor.id}::uuid)`;

        const totals = await tx<{ total: string }[]>`
          SELECT count(*)::text AS total FROM public_core.recruitment_campaigns c WHERE true ${filters}`;
        const rows = await tx<CampaignRow[]>`
          SELECT ${campaignSelect(tx)}
          FROM ${campaignFrom(tx)}
          WHERE true ${filters} ${cursorFilter}
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT ${search.limit + 1}`;
        return {
          total: Number(totals[0]?.total ?? '0'),
          hasMore: rows.length > search.limit,
          rows: rows.slice(0, search.limit).map((r) => ({ summary: toSummary(r), sortKey: r.sort_key, cursorId: r.id })),
        };
      });
    } catch (cause) {
      throw new ApplicationReadError('Could not list the agency campaigns.', { cause });
    }
  }

  async findCampaignDetail(scope: AgencyScope, publicCode: string): Promise<CampaignAdminDetail | null> {
    try {
      return await asOfficer(scope, async (tx) => {
        const rows = await tx<(CampaignRow & {
          contact_phone_numbers: string | null;
          contact_website: string | null;
          announcement_reference: string | null;
          registration_closed_at: Timestamptz | null;
          cancelled_at: Timestamptz | null;
          current_policy_version_id: string | null;
        })[]>`
          SELECT ${campaignSelect(tx)},
                 c.contact_phone_numbers, c.contact_website, c.announcement_reference,
                 c.registration_closed_at, c.cancelled_at, c.current_policy_version_id
          FROM ${campaignFrom(tx)}
          WHERE c.public_code = ${publicCode} AND c.agency = ${scope.agency}::public_core.agency
          LIMIT 1`;
        const row = rows[0];
        if (row === undefined) return null;

        const policyRows = row.current_policy_version_id === null ? [] : await tx<{
          version_number: number; policy_hash: string; hash_version: number; legal_basis_code: string; created_at: Timestamptz;
        }[]>`
          SELECT version_number, policy_hash, hash_version, legal_basis_code, created_at
          FROM public_core.campaign_policy_versions WHERE id = ${row.current_policy_version_id}`;
        const coverageRows = await tx<{ coverage_version: number; coverage_hash: string }[]>`
          SELECT coverage_version, coverage_hash FROM public_core.campaign_coverage_heads WHERE campaign_id = ${row.id}`;
        const sessionRows = await tx<{
          district: string; province: string; venue_name: string; exam_date: string; reporting_time_hour: number;
          capacity_limit: number | null; capacity_decision_code: string | null; registered_count: number; is_active: boolean;
        }[]>`
          SELECT district, province, venue_name, exam_date, reporting_time_hour,
                 capacity_limit, capacity_decision_code, registered_count, is_active
          FROM public_core.campaign_venue_assignments WHERE campaign_id = ${row.id}
          ORDER BY exam_date ASC, district ASC`;
        const historyRows = await tx<{
          from_status: CampaignStatus | null; to_status: CampaignStatus; reason_code: string | null; occurred_at: Timestamptz;
        }[]>`
          SELECT from_status::text AS from_status, to_status::text AS to_status, reason_code, occurred_at
          FROM public_core.campaign_lifecycle_history WHERE campaign_id = ${row.id}
          ORDER BY occurred_at ASC, id ASC`;

        const policy = policyRows[0];
        const coverage = coverageRows[0];
        const sessions = sessionRows.map((s): CampaignSessionOccupancy => ({
          district: s.district,
          province: s.province,
          venueName: s.venue_name,
          examDate: s.exam_date,
          reportingTimeHour: s.reporting_time_hour,
          capacityLimit: s.capacity_limit,
          capacityDecisionCode: s.capacity_decision_code,
          registeredCount: s.registered_count,
          remaining: s.capacity_limit === null ? null : Math.max(0, s.capacity_limit - s.registered_count),
          isActive: s.is_active,
        }));
        return {
          summary: toSummary(row),
          contactPhoneNumbers: row.contact_phone_numbers === null ? null : jsonStrings(row.contact_phone_numbers),
          contactWebsite: row.contact_website,
          announcementReference: row.announcement_reference,
          registrationClosedAt: isoOrNull(row.registration_closed_at),
          cancelledAt: isoOrNull(row.cancelled_at),
          policy: policy === undefined ? null : {
            versionNumber: policy.version_number,
            policyHash: policy.policy_hash,
            hashVersion: policy.hash_version,
            legalBasisCode: policy.legal_basis_code,
            createdAt: iso(policy.created_at),
          },
          coverage: coverage === undefined ? null : { version: coverage.coverage_version, hash: coverage.coverage_hash },
          sessions,
          history: historyRows.map((h) => ({
            fromStatus: h.from_status,
            toStatus: h.to_status,
            reasonCode: h.reason_code,
            occurredAt: iso(h.occurred_at),
          })),
        };
      });
    } catch (cause) {
      throw new ApplicationReadError('Could not read the campaign.', { cause });
    }
  }

  async venueRoster(scope: AgencyScope, query: RosterQuery): Promise<VenueRoster | null> {
    const schema = sql(schemaForAgency(scope.agency));
    try {
      return await asOfficer(scope, async (tx) => {
        // The venue day is the campaign's session for that district on that date.
        const venues = await tx<{
          campaign_id: string; venue_name: string; reporting_time_hour: number; capacity_limit: number | null; registered_count: number;
        }[]>`
          SELECT c.id AS campaign_id, v.venue_name, v.reporting_time_hour, v.capacity_limit, v.registered_count
          FROM public_core.recruitment_campaigns c
          JOIN public_core.campaign_venue_assignments v ON v.campaign_id = c.id
          WHERE c.public_code = ${query.campaignPublicCode}
            AND c.agency = ${scope.agency}::public_core.agency
            AND v.district = ${query.district}
            AND v.exam_date = ${query.examDate}
          LIMIT 1`;
        const venue = venues[0];
        if (venue === undefined) return null;

        // Minimum set: processing code, category, status, admission, paper items.
        // applicant_id, names, National IDs, QR tokens and contact never leave SQL.
        const rows = await tx<{
          processing_code: string; category: string; status: ApplicationStatus; admitted: boolean; required: unknown;
        }[]>`
          SELECT a.processing_code, a.category::text AS category, a.status::text AS status,
                 (g.id IS NOT NULL) AS admitted,
                 pv.policy_document -> (a.category::text) -> 'requiredDocumentTypes' AS required
          FROM ${schema}.applications a
          LEFT JOIN ${schema}.gate_admissions g ON g.application_id = a.id
          LEFT JOIN public_core.campaign_policy_versions pv ON pv.id = a.policy_version_id
          WHERE a.campaign_id = ${venue.campaign_id}
            AND a.assigned_district = ${query.district}
            AND a.status::text IN ('SLOT_ASSIGNED', 'PHYSICAL_TEST_SCHEDULED', 'PHYSICAL_TEST_COMPLETE')
          ORDER BY a.processing_code ASC
          LIMIT ${MAX_ROSTER_ROWS + 1}`;

        const entries = rows.slice(0, MAX_ROSTER_ROWS).map((r): RosterEntry => ({
          processingCode: r.processing_code,
          category: r.category,
          status: r.status,
          admission: r.admitted ? 'ADMITTED' : 'NOT_ADMITTED',
          requiredPaperItems: resolveRequiredDocuments(
            r.category as Parameters<typeof resolveRequiredDocuments>[0],
            Array.isArray(r.required) && r.required.every((v): v is string => typeof v === 'string')
              ? (r.required as DocumentType[])
              : undefined,
          ).types,
        }));
        return {
          venueName: venue.venue_name,
          district: query.district,
          examDate: query.examDate,
          reportingTimeHour: venue.reporting_time_hour,
          capacityLimit: venue.capacity_limit,
          registeredCount: venue.registered_count,
          entries,
          truncated: rows.length > MAX_ROSTER_ROWS,
        };
      });
    } catch (cause) {
      throw new ApplicationReadError('Could not read the venue roster.', { cause });
    }
  }
}
