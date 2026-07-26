// ══════════════════════════════════════════════════════════════════
// application-service — ListApplications use case (officer read)
//
// Lists the authenticated officer's OWN agency's applications. The agency is
// taken from the verified Principal — never from the request — so an officer
// can only ever enumerate their own agency. The use case resolves the DB role
// (dbRoleForPrincipal) and hands it to the repository, which runs the query
// under that officer role. A non-officer principal is rejected here as
// defense-in-depth even though the HTTP wrapper already blocks the wrong kind.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import type {
  AmberQueueEntry,
  ApplicantApplicationSummary,
  ApplicationReadRepository,
  ApplicationSummary,
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
}
