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
}
