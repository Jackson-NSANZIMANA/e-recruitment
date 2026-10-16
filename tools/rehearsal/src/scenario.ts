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
  readonly examOffsetDays: number;
  readonly reportingHour: number;
  readonly capacity: number;
}

export interface ScenarioCampaign {
  readonly agency: string;
  readonly categories: readonly string[];
  readonly registration: { readonly opensOffsetDays: number; readonly closesOffsetDays: number };
  readonly examination: { readonly startOffsetDays: number; readonly endOffsetDays: number };
  readonly reportingHour: number;
  readonly allowsWalkIn: boolean;
  readonly targetIntakeCount: number;
  readonly sessions: readonly ScenarioSession[];
}

export interface ScenarioPersona {
  readonly id: string;
  readonly role: string;
  readonly nationalId: string;
  readonly dateOfBirth: string;
  readonly phone: string;
  readonly homeDistrict: string;
  readonly rehearses: string;
  readonly expectedOutcome: string;
}

export interface Scenario {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly purpose: string;
  readonly campaigns: readonly ScenarioCampaign[];
  readonly personas: readonly ScenarioPersona[];
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
  const personaIds = new Set<string>();
  for (const persona of scenario.personas) {
    check(!personaIds.has(persona.id), `Persona ${persona.id} appears twice.`);
    personaIds.add(persona.id);
    check(/^\d{16}$/.test(persona.nationalId), `Persona ${persona.id}: National ID must be 16 digits.`);
    check(/^\d{4}-\d{2}-\d{2}$/.test(persona.dateOfBirth), `Persona ${persona.id}: date of birth YYYY-MM-DD.`);
    check(isDistrict(persona.homeDistrict), `Persona ${persona.id}: unknown district ${persona.homeDistrict}.`);
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
        venueName: `Rehearsal Venue — ${titleCase(district)}`,
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
    };
  });
}
