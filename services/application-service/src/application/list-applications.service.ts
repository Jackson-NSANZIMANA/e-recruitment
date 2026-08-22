// ══════════════════════════════════════════════════════════════════
// application-service — ListApplications use case (officer read)
//
// Lists the authenticated officer's OWN agency's applications. The agency is
// taken from the verified Principal — never from the request — so an officer
// can only ever enumerate their own agency. The use case resolves the DB role
// (dbRoleForPrincipal) and hands it to the repository, which runs the query
// under that officer role. A non-officer principal is rejected here as
// defense-in-depth even though the HTTP wrapper already blocks the wrong kind.
//
// It also owns the two SINGLE-application reads behind the officer console's
// detail screen: the record itself and its immutable status trail. Both are
// agency-scoped through exactly the same seam, so neither can become a
// cross-agency window.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import type {
  AmberQueueEntry,
  ApplicantApplicationSummary,
  ApplicationDetail,
  ApplicationReadRepository,
  ApplicationSummary,
  StatusHistoryEntry,
} from '../ports/application-read-repository.js';

const DEFAULT_MAX_RESULTS = 100;

export interface ListApplicationsCommand {
  readonly actor: Principal;
}

export type ListApplicationsOutcome =
  | { readonly kind: 'OK'; readonly agency: Agency; readonly applications: readonly ApplicationSummary[] }
  | { readonly kind: 'FORBIDDEN' };

export type AmberQueueOutcome =
  | { readonly kind: 'OK'; readonly agency: Agency; readonly queue: readonly AmberQueueEntry[] }
  | { readonly kind: 'FORBIDDEN' };

export interface ListByApplicantCommand {
  readonly actor: Principal;
  readonly applicantId: string;
}

export type ListByApplicantOutcome =
  | { readonly kind: 'OK'; readonly applications: readonly ApplicantApplicationSummary[] }
  | { readonly kind: 'FORBIDDEN' };

/** Addressing ONE application. The agency is NOT a parameter — it is derived
 *  from the verified actor, which is what makes this read un-widenable. */
export interface ReadApplicationCommand {
  readonly actor: Principal;
  readonly applicationId: string;
}

export type FindApplicationOutcome =
  | { readonly kind: 'OK'; readonly agency: Agency; readonly application: ApplicationDetail }
  /** No such application IN THIS OFFICER'S AGENCY. Indistinguishable from
   *  "exists but belongs to a sibling agency" — deliberately, so 404 is not
   *  an existence oracle for another agency's caseload. */
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FORBIDDEN' };

export type StatusHistoryOutcome =
  | {
      readonly kind: 'OK';
      readonly agency: Agency;
      readonly applicationId: string;
      readonly history: readonly StatusHistoryEntry[];
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FORBIDDEN' };

export interface ListApplicationsDeps {
  readonly reader: ApplicationReadRepository;
  readonly maxResults?: number;
}

export class ListApplicationsService {
  readonly #reader: ApplicationReadRepository;
  readonly #maxResults: number;

  constructor(deps: ListApplicationsDeps) {
    this.#reader = deps.reader;
    this.#maxResults = deps.maxResults ?? DEFAULT_MAX_RESULTS;
  }

  async list(command: ListApplicationsCommand): Promise<ListApplicationsOutcome> {
    const { actor } = command;
    if (actor.kind !== 'officer') {
      return { kind: 'FORBIDDEN' };
    }
    const applications = await this.#reader.listByAgency({
      agency: actor.agency,
      dbRole: dbRoleForPrincipal(actor),
      limit: this.#maxResults,
    });
    return { kind: 'OK', agency: actor.agency, applications };
  }

  /**
   * ALL of one applicant's applications, cross-agency (ADR-018). The caller
   * is a SYSTEM principal — the applicant portal's backend, which has already
   * authenticated the citizen session and asks on their behalf. Officers use
   * the agency-scoped list above; they are refused here (an officer must not
   * gain a cross-agency view through the citizen door).
   */
  async listByApplicant(command: ListByApplicantCommand): Promise<ListByApplicantOutcome> {
    if (command.actor.kind !== 'system') {
      return { kind: 'FORBIDDEN' };
    }
    const applications = await this.#reader.listByApplicant(command.applicantId);
    return { kind: 'OK', applications };
  }

  /** The officer's agency review queue (amber + adjudication holds, ADR-011). */
  async amberQueue(command: ListApplicationsCommand): Promise<AmberQueueOutcome> {
    const { actor } = command;
    if (actor.kind !== 'officer') {
      return { kind: 'FORBIDDEN' };
    }
    const queue = await this.#reader.listAmberQueue({
      agency: actor.agency,
      dbRole: dbRoleForPrincipal(actor),
      limit: this.#maxResults,
    });
    return { kind: 'OK', agency: actor.agency, queue };
  }

  /**
   * ONE application from the officer's own agency — the data source the
   * console's detail screen never had.
   *
   * NOT_FOUND is an OUTCOME, not a thrown error: a missing record is an
   * expected answer, and only genuinely exceptional conditions throw here.
   */
  async findById(command: ReadApplicationCommand): Promise<FindApplicationOutcome> {
    const { actor } = command;
    if (actor.kind !== 'officer') {
      return { kind: 'FORBIDDEN' };
    }
    const application = await this.#reader.findById({
      agency: actor.agency,
      dbRole: dbRoleForPrincipal(actor),
      applicationId: command.applicationId,
    });
    if (application === null) {
      return { kind: 'NOT_FOUND' };
    }
    return { kind: 'OK', agency: actor.agency, application };
  }

  /**
   * The immutable status trail for ONE application (rls/0007), oldest first.
   *
   * This read IS the Procedural Justice requirement: an applicant is entitled
   * to know who moved their application, when, and on what stated ground, and
   * the officer console is where that answer is surfaced. The trail is
   * append-only in the database by trigger AND by revoked grant, so what comes
   * back is a forensic record rather than a mutable log.
   */
  async statusHistory(command: ReadApplicationCommand): Promise<StatusHistoryOutcome> {
    const { actor } = command;
    if (actor.kind !== 'officer') {
      return { kind: 'FORBIDDEN' };
    }
    const history = await this.#reader.listStatusHistory({
      agency: actor.agency,
      dbRole: dbRoleForPrincipal(actor),
      applicationId: command.applicationId,
    });
    if (history === null) {
      return { kind: 'NOT_FOUND' };
    }
    return {
      kind: 'OK',
      agency: actor.agency,
      applicationId: command.applicationId,
      history,
    };
  }
}
