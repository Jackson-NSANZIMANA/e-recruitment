// ══════════════════════════════════════════════════════════════════
// rehearsal — scenarios
//
// A scenario is a versioned description of a recruitment day, written
// relative to "today" so it can be replayed on any date. Everything a
// scenario produces is unmistakably synthetic: public codes start with
// REH-, labels with [REHEARSAL], venues say "Rehearsal", and the legal basis
// is SYNTHETIC-REHEARSAL. The derivation here is pure; the conductor plays it.
// ══════════════════════════════════════════════════════════════════

import {
  AGENCIES,
  CATEGORY_TO_AGENCY,
  DISTRICT_TO_PROVINCE,
  type Agency,
  type ApplicationCategory,
  type District,
  type Province,
} from '@usrp/shared-types';
import { kigaliDate, kigaliInstant, kigaliStamp, shortDay } from './clock.js';

export const REHEARSAL_CODE_PREFIX = 'REH-';
export const REHEARSAL_LABEL_PREFIX = '[REHEARSAL]';

export interface ScenarioSession {
  readonly district: string;
  /** The printed venue name; staged as "Rehearsal Venue — <venue>". Defaults to the district. */
  readonly venue?: string;
  readonly examOffsetDays: number;
  readonly reportingHour: number;
  readonly capacity: number;
}

/** A station officer the day needs, provisioned through the ADR-036 operations. */
export interface ScenarioStaff {
  readonly handle: string;
  readonly posts: readonly string[];
}

/** Posts an agency administrator may assign (ADR-036: never agency_admin). */
export const ASSIGNABLE_POSTS: readonly string[] = [
  'reviewer', 'screening_officer', 'field_supervisor', 'medical_officer', 'adjudicator', 'decision_authority', 'dpo',
];

export interface ScenarioCampaign {
  readonly agency: string;
  readonly categories: readonly string[];
  readonly registration: { readonly opensOffsetDays: number; readonly closesOffsetDays: number };
  readonly examination: { readonly startOffsetDays: number; readonly endOffsetDays: number };
  readonly reportingHour: number;
  readonly allowsWalkIn: boolean;
  readonly targetIntakeCount: number;
  readonly sessions: readonly ScenarioSession[];
  /** Optional: the station officers the `staff` step provisions (ADR-036). */
  readonly staff?: readonly ScenarioStaff[];
  /**
   * Optional (ADR-037): the biometric evidence mode the platform must be
   * running for this agency. The rehearsal checks it through
   * getBiometricPolicy; it never sets it (that is BIOMETRIC_MODE_<AGENCY>).
   */
  readonly biometricMode?: 'OFF' | 'SHADOW' | 'ADVISORY';
}

/** What the sandbox journey (`pnpm rehearse --journey`) must observe for a persona. */
export type JourneyExpectation =
  | { readonly outcome: 'ADMITTED' }
  | { readonly outcome: 'REJECTED'; readonly gate: 'AGE' | 'ACADEMIC' }
  | { readonly outcome: 'ACADEMIC_PENDING'; readonly failureCode: string };

/**
 * A persona: either literal identity facts (dev stack, national-pilot-day),
 * or a g2g-sandbox catalogue persona whose facts the simulator serves
 * (`sandboxPersona`, ADR-047 §3.4; ages relative to today).
 */
export interface ScenarioPersona {
  readonly id: string;
  readonly role: string;
  readonly nationalId?: string;
  readonly dateOfBirth?: string;
  readonly phone?: string;
  readonly homeDistrict?: string;
  readonly sandboxPersona?: string;
  /** The category the journey applies to (sandbox personas). */
  readonly category?: string;
  readonly expect?: JourneyExpectation;
  readonly rehearses: string;
  readonly expectedOutcome: string;
}

// ── Announcement facts (docs/product/recruitment-announcements-2025-2026.md) ──

export const ANNOUNCEMENTS_SOURCE = 'docs/product/recruitment-announcements-2025-2026.md';

export interface AnnouncementCategory {
  readonly category: string;
  readonly track: string;
  /** Alternatives: any one of these levels satisfies the requirement. */
  readonly educationAnyOf: readonly string[];
  /** Age bounds by qualification inside the category (one entry when uniform). */
  readonly ageCaps: readonly { readonly qualification: string; readonly minAge?: number; readonly maxAge: number }[];
  readonly convictionRule: string;
  readonly underProsecutionBars?: boolean;
  readonly extraConditions?: readonly string[];
}

export interface AnnouncementVenue {
  readonly province?: string;
  readonly districts: readonly string[];
  readonly dates: readonly string[];
  readonly venue: string;
}

export interface AnnouncementNote {
  readonly kind: 'INCONSISTENCY_IN_ORIGINAL' | 'NOT_IN_ANNOUNCEMENT' | 'POLICY_MODEL_GAP' | 'REHEARSAL_COMPRESSION' | 'OWNER_DECISION';
  readonly section: string;
  readonly text: string;
}

/** The printed facts, verbatim. Validated by the publication preflight below. */
export interface Announcement {
  readonly source: string;
  readonly agency: string;
  readonly title: string;
  readonly signedOn: string;
  readonly registration: { readonly opens: string; readonly closes: string; readonly where: string };
  readonly walkInOnExamDay: boolean;
  readonly examination: { readonly start: string; readonly end: string; readonly hour: string } | null;
  readonly categories: readonly AnnouncementCategory[];
  readonly documents: readonly string[];
  readonly venues: readonly AnnouncementVenue[];
  readonly notes: readonly AnnouncementNote[];
}

export interface Scenario {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly purpose: string;
  readonly campaigns: readonly ScenarioCampaign[];
  readonly personas: readonly ScenarioPersona[];
  /** Present on scenarios encoded from a real announcement. */
  readonly announcement?: Announcement;
}

export class ScenarioInvalid extends Error {
  override readonly name = 'ScenarioInvalid';
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ScenarioInvalid(message);
}

function isAgency(value: string): value is Agency {
  return (AGENCIES as readonly string[]).includes(value);
}

function isDistrict(value: string): value is District {
  return Object.hasOwn(DISTRICT_TO_PROVINCE, value);
}

/** PURE. Rejects a scenario the control plane would refuse, before any call is made. */
export function validateScenario(scenario: Scenario): void {
  check(/^[a-z0-9][a-z0-9-]{2,40}$/.test(scenario.id), `Scenario id "${scenario.id}" must be a short kebab-case token.`);
  check(Number.isInteger(scenario.version) && scenario.version >= 1, 'Scenario version must be a positive integer.');
  check(scenario.campaigns.length > 0, 'A scenario needs at least one campaign.');
  const agencies = new Set<string>();
  for (const campaign of scenario.campaigns) {
    check(isAgency(campaign.agency), `Unknown agency "${campaign.agency}".`);
    check(!agencies.has(campaign.agency), `Agency ${campaign.agency} appears twice; one rehearsal campaign per agency per day.`);
    agencies.add(campaign.agency);
    check(campaign.categories.length > 0, `${campaign.agency}: at least one category.`);
    for (const category of campaign.categories) {
      check(CATEGORY_TO_AGENCY.get(category) === campaign.agency, `${campaign.agency}: category ${category} belongs to another agency.`);
    }
    check(campaign.registration.opensOffsetDays < campaign.registration.closesOffsetDays, `${campaign.agency}: registration must open before it closes.`);
    check(campaign.examination.startOffsetDays <= campaign.examination.endOffsetDays, `${campaign.agency}: examination start after end.`);
    check(Number.isInteger(campaign.reportingHour) && campaign.reportingHour >= 0 && campaign.reportingHour <= 23, `${campaign.agency}: reporting hour 0..23.`);
    check(campaign.sessions.length > 0, `${campaign.agency}: at least one session.`);
    const districts = new Set<string>();
    for (const session of campaign.sessions) {
      check(isDistrict(session.district), `${campaign.agency}: unknown district ${session.district}.`);
      // BUILD-001 coverage is one session per district.
      check(!districts.has(session.district), `${campaign.agency}: district ${session.district} has two sessions.`);
      districts.add(session.district);
      check(
        session.examOffsetDays >= campaign.examination.startOffsetDays && session.examOffsetDays <= campaign.examination.endOffsetDays,
        `${campaign.agency}/${session.district}: exam day outside the examination window.`,
      );
      check(Number.isInteger(session.capacity) && session.capacity >= 1, `${campaign.agency}/${session.district}: capacity must be a positive integer.`);
    }
  }
  const staffHandles = new Set<string>();
  for (const campaign of scenario.campaigns) {
    for (const member of campaign.staff ?? []) {
      check(/^reh\.[a-z0-9][a-z0-9._-]{2,59}$/.test(member.handle), `${campaign.agency}: staff handle "${member.handle}" must start with "reh." (rehearsal-marked).`);
      check(!staffHandles.has(member.handle), `Staff handle ${member.handle} appears twice.`);
      staffHandles.add(member.handle);
      check(member.posts.length > 0 && new Set(member.posts).size === member.posts.length, `${member.handle}: at least one post, no duplicates.`);
      for (const post of member.posts) {
        check(ASSIGNABLE_POSTS.includes(post), `${member.handle}: "${post}" is not an assignable post (agency_admin never is).`);
      }
    }
  }
  for (const campaign of scenario.campaigns) {
    if (campaign.biometricMode !== undefined) {
      check(['OFF', 'SHADOW', 'ADVISORY'].includes(campaign.biometricMode), `${campaign.agency}: biometricMode must be OFF, SHADOW or ADVISORY (there is no automatic mode).`);
    }
  }
  const personaIds = new Set<string>();
  for (const persona of scenario.personas) {
    check(!personaIds.has(persona.id), `Persona ${persona.id} appears twice.`);
    personaIds.add(persona.id);
    if (persona.sandboxPersona !== undefined) {
      check(/^[A-Z]-[A-Z0-9-]{2,60}$/.test(persona.sandboxPersona), `Persona ${persona.id}: sandboxPersona must be a catalogue id.`);
      check(persona.category !== undefined && CATEGORY_TO_AGENCY.has(persona.category), `Persona ${persona.id}: a sandbox persona names its category.`);
      check(persona.expect !== undefined, `Persona ${persona.id}: a sandbox persona states its expected journey outcome.`);
      continue;
    }
    check(/^\d{16}$/.test(persona.nationalId ?? ''), `Persona ${persona.id}: National ID must be 16 digits.`);
    check(/^\d{4}-\d{2}-\d{2}$/.test(persona.dateOfBirth ?? ''), `Persona ${persona.id}: date of birth YYYY-MM-DD.`);
    check(isDistrict(persona.homeDistrict ?? ''), `Persona ${persona.id}: unknown district ${String(persona.homeDistrict)}.`);
  }
  if (scenario.announcement !== undefined) validateAnnouncement(scenario.announcement);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * PURE. The PUBLICATION PREFLIGHT for an announcement as printed: refuses a
 * calendar the platform could not publish honestly. Inconsistencies are
 * never "fixed" here; a scenario that needs a correction carries it in a
 * separate file that cites the note (ADR-035, S12a kit item 12).
 */
export function validateAnnouncement(a: Announcement): void {
  check(a.source.startsWith(ANNOUNCEMENTS_SOURCE), `Announcement must cite ${ANNOUNCEMENTS_SOURCE} (never a translation).`);
  check(isAgency(a.agency), `Announcement: unknown agency ${a.agency}.`);
  for (const d of [a.signedOn, a.registration.opens, a.registration.closes]) check(ISO_DATE.test(d), `Announcement: dates are YYYY-MM-DD (${d}).`);
  check(a.registration.opens <= a.registration.closes, 'Announcement: registration closes before it opens.');
  check(a.signedOn <= a.registration.opens, 'Announcement: signed after registration opens.');
  check(a.categories.length > 0, 'Announcement: at least one category.');
  for (const c of a.categories) {
    check(CATEGORY_TO_AGENCY.get(c.category) === a.agency, `Announcement: category ${c.category} is not ${a.agency}'s.`);
    check(c.educationAnyOf.length > 0 && c.ageCaps.length > 0, `Announcement: ${c.category} needs education and age facts.`);
  }
  check(a.documents.length > 0, 'Announcement: the documents list is part of the facts.');
  if (a.examination === null) {
    check(a.venues.length === 0, 'Announcement: venues without an examination window.');
    return;
  }
  const { start, end } = a.examination;
  check(ISO_DATE.test(start) && ISO_DATE.test(end) && start <= end, 'Announcement: examination window malformed.');
  check(start >= a.registration.opens, `Announcement: examinations (${start}) begin before registration opens (${a.registration.opens}).`);
  const covered = new Set<string>();
  for (const v of a.venues) {
    for (const d of v.districts) {
      check(isDistrict(d), `Announcement: unknown district ${d}.`);
      check(!covered.has(d), `Announcement: district ${d} listed twice.`);
      covered.add(d);
      if (v.province !== undefined) check(DISTRICT_TO_PROVINCE[d] === v.province, `Announcement: ${d} printed under ${v.province}, but it is in ${DISTRICT_TO_PROVINCE[d]}.`);
    }
    for (const date of v.dates) {
      check(ISO_DATE.test(date), `Announcement: venue date ${date} malformed.`);
      check(date >= start && date <= end, `Announcement: ${v.districts.join('/')} sits on ${date}, outside the printed examination window ${start}…${end}.`);
    }
  }
}

export interface CampaignDraftCommand {
  readonly publicCode: string;
  readonly campaignLabel: string;
  readonly targetCategories: readonly ApplicationCategory[];
  readonly targetDistricts: readonly District[];
  readonly registrationOpensAt: string;
  readonly registrationClosesAt: string;
  readonly examinationStartDate: string;
  readonly examinationEndDate: string;
  readonly examinationReportingHour: number;
  readonly allowsWalkIn: boolean;
  readonly targetIntakeCount: number;
  readonly contactPhoneNumbers: readonly string[];
}

export interface SessionCommand {
  readonly publicCode: string;
  readonly district: District;
  readonly province: Province;
  readonly venueName: string;
  readonly examDate: string;
  readonly reportingTimeHour: number;
  readonly capacityLimit: number;
  readonly isActive: true;
}

export interface StagedCampaign {
  readonly agency: Agency;
  readonly draft: CampaignDraftCommand;
  readonly sessions: readonly SessionCommand[];
  readonly staff: readonly ScenarioStaff[];
  readonly biometricMode: 'OFF' | 'SHADOW' | 'ADVISORY' | null;
}

/** PURE. The public code of an agency's rehearsal campaign for the Kigali day of `now`. */
export function rehearsalCode(agency: Agency, now: Date): string {
  return `${REHEARSAL_CODE_PREFIX}${agency}-${kigaliStamp(now)}`;
}

/** PURE. True for any rehearsal campaign code (any day). */
export function isRehearsalCode(publicCode: string): boolean {
  return publicCode.startsWith(REHEARSAL_CODE_PREFIX);
}

function titleCase(district: string): string {
  return district.charAt(0) + district.slice(1).toLowerCase();
}

/** PURE. The concrete control-plane commands a scenario produces on the day of `now`. */
export function stageCampaigns(scenario: Scenario, now: Date): readonly StagedCampaign[] {
  validateScenario(scenario);
  return scenario.campaigns.map((campaign) => {
    const agency = campaign.agency as Agency;
    const publicCode = rehearsalCode(agency, now);
    const today = kigaliDate(now);
    const sessions = campaign.sessions.map((session): SessionCommand => {
      const district = session.district as District;
      return {
        publicCode,
        district,
        province: DISTRICT_TO_PROVINCE[district],
        venueName: `Rehearsal Venue — ${session.venue ?? titleCase(district)}`,
        examDate: kigaliDate(now, session.examOffsetDays),
        reportingTimeHour: session.reportingHour,
        capacityLimit: session.capacity,
        isActive: true,
      };
    });
    return {
      agency,
      draft: {
        publicCode,
        campaignLabel: `${REHEARSAL_LABEL_PREFIX} ${agency} ${shortDay(today)}`,
        targetCategories: campaign.categories as readonly ApplicationCategory[],
        targetDistricts: sessions.map((session) => session.district),
        registrationOpensAt: kigaliInstant(now, campaign.registration.opensOffsetDays, 'start'),
        registrationClosesAt: kigaliInstant(now, campaign.registration.closesOffsetDays, 'end'),
        examinationStartDate: kigaliDate(now, campaign.examination.startOffsetDays),
        examinationEndDate: kigaliDate(now, campaign.examination.endOffsetDays),
        examinationReportingHour: campaign.reportingHour,
        allowsWalkIn: campaign.allowsWalkIn,
        targetIntakeCount: campaign.targetIntakeCount,
        contactPhoneNumbers: [],
      },
      sessions,
      staff: campaign.staff ?? [],
      biometricMode: campaign.biometricMode ?? null,
    };
  });
}
