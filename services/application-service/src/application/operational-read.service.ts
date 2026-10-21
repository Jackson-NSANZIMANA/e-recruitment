// ══════════════════════════════════════════════════════════════════
// application-service — Operational read use cases (ADR-039)
//
// The agency and the DB role come from the verified officer Principal, never
// from the request. A non-officer principal is refused here as well as by the
// HTTP wrapper (defence in depth).
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';
import { dbRoleForPrincipal, type Principal } from '@usrp/shared-auth';
import {
  encodeCursor,
  type ApplicationSearch,
  type CampaignAdminSearch,
  type RosterQuery,
} from '../domain/operational-reads.js';
import type {
  AgencyScope,
  ApplicationSearchRow,
  CampaignAdminDetail,
  CampaignAdminSummary,
  OperationalReadRepository,
  VenueRoster,
} from '../ports/operational-read-repository.js';

export type Paged<T> =
  | {
      readonly kind: 'OK';
      readonly agency: Agency;
      readonly items: readonly T[];
      readonly total: number;
      readonly nextCursor: string | null;
    }
  | { readonly kind: 'FORBIDDEN' };

export type DetailOutcome<T> =
  | { readonly kind: 'OK'; readonly agency: Agency; readonly value: T }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'FORBIDDEN' };

export interface OperationalReadDeps {
  readonly reader: OperationalReadRepository;
}

function scopeOf(actor: Principal): AgencyScope | null {
  if (actor.kind !== 'officer') return null;
  return { agency: actor.agency, dbRole: dbRoleForPrincipal(actor) };
}

/** The cursor names the LAST served row; null when the page is the final one. */
function next<T extends { readonly sortKey: string }>(
  rows: readonly T[],
  hasMore: boolean,
  idOf: (row: T) => string,
): string | null {
  const last = rows.at(-1);
  return hasMore && last !== undefined ? encodeCursor({ sortKey: last.sortKey, id: idOf(last) }) : null;
}

export class OperationalReadService {
  readonly #reader: OperationalReadRepository;

  constructor(deps: OperationalReadDeps) {
    this.#reader = deps.reader;
  }

  async searchApplications(actor: Principal, search: ApplicationSearch): Promise<Paged<Omit<ApplicationSearchRow, 'sortKey'>>> {
    const scope = scopeOf(actor);
    if (scope === null) return { kind: 'FORBIDDEN' };
    const page = await this.#reader.searchApplications(scope, search);
    return {
      kind: 'OK',
      agency: scope.agency,
      total: page.total,
      nextCursor: next(page.rows, page.hasMore, (r) => r.applicationId),
      items: page.rows.map(({ sortKey: _sortKey, ...item }) => item),
    };
  }

  async listCampaigns(actor: Principal, search: CampaignAdminSearch): Promise<Paged<CampaignAdminSummary>> {
    const scope = scopeOf(actor);
    if (scope === null) return { kind: 'FORBIDDEN' };
    const page = await this.#reader.listCampaigns(scope, search);
    return {
      kind: 'OK',
      agency: scope.agency,
      total: page.total,
      nextCursor: next(page.rows, page.hasMore, (r) => r.cursorId),
      items: page.rows.map((r) => r.summary),
    };
  }

  async campaignDetail(actor: Principal, publicCode: string): Promise<DetailOutcome<CampaignAdminDetail>> {
    const scope = scopeOf(actor);
    if (scope === null) return { kind: 'FORBIDDEN' };
    const value = await this.#reader.findCampaignDetail(scope, publicCode);
    return value === null ? { kind: 'NOT_FOUND' } : { kind: 'OK', agency: scope.agency, value };
  }

  async venueRoster(actor: Principal, query: RosterQuery): Promise<DetailOutcome<VenueRoster>> {
    const scope = scopeOf(actor);
    if (scope === null) return { kind: 'FORBIDDEN' };
    const value = await this.#reader.venueRoster(scope, query);
    return value === null ? { kind: 'NOT_FOUND' } : { kind: 'OK', agency: scope.agency, value };
  }
}
