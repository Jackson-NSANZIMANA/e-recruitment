// ══════════════════════════════════════════════════════════════════
// @usrp/shared-auth — Verified in-process identity + DB-role policy
//
// A `Principal` is the trusted result of verifying a token: either an
// agency officer or a cross-agency system worker. `dbRoleForPrincipal` is
// the PURE policy that maps a principal onto the Postgres role a request
// should assume via `SET LOCAL ROLE` — the seam that finally drives the
// dormant per-agency officer roles from rls/0001.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

/** The verified caller. Officer carries its agency; system is cross-agency. */
export type Principal =
  | {
      readonly kind: 'officer';
      readonly subjectId: string;
      readonly agency: Agency;
      readonly roles: readonly string[];
    }
  | {
      readonly kind: 'system';
      readonly subjectId: string;
    };

/**
 * The Postgres roles a principal may assume. These are exactly the group
 * roles `usrp_app` is a member of (rls/0001), so `SET LOCAL ROLE` always
 * succeeds. A future `superadmin` kind is intentionally NOT mapped here
 * until a concrete oversight requirement adds a dedicated least-privilege
 * role — see the engagement notes.
 */
export type DbRole =
  | 'usrp_rdf_officer'
  | 'usrp_rnp_officer'
  | 'usrp_rcs_officer'
  | 'usrp_system_service';

const OFFICER_DB_ROLE: Readonly<Record<Agency, DbRole>> = {
  RDF: 'usrp_rdf_officer',
  RNP: 'usrp_rnp_officer',
  RCS: 'usrp_rcs_officer',
} as const;

/** PURE. officer → usrp_<agency>_officer; system → usrp_system_service. */
export function dbRoleForPrincipal(principal: Principal): DbRole {
  return principal.kind === 'officer'
    ? OFFICER_DB_ROLE[principal.agency]
    : 'usrp_system_service';
}
