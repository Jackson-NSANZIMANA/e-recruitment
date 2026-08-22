// ══════════════════════════════════════════════════════════════════
// document-forensics-service — ApplicationOwnershipReader port
//
// WHY THE UPLOAD INGRESS MUST NOT BE TOLD THE AGENCY.
//
// analyze/ takes `agency` in the body because its caller is another service
// handing over a reference it already owns. The upload route's caller is the
// EDGE, acting for a citizen — and a citizen must not be able to name which
// agency's schema their bytes land in. So the agency is DERIVED: this port
// searches for the application by (id AND applicant_id) and reports which
// agency actually holds it. Same posture as ADR-020's self-withdrawal, where
// the ownership check IS the row lookup.
//
// TWO PROPERTIES THAT FALL OUT OF THAT SHAPE:
//
//   • A valid system token cannot attach a document to someone else's
//     application. The applicant id is part of the predicate, not a label.
//
//   • "Not yours" and "does not exist" are the SAME null, so the route is not
//     an application-existence oracle. A caller cannot enumerate application
//     ids by watching 404 flip to 409.
//
// `status` comes back as TEXT, not a typed enum: the three ops schemas have
// genuinely different application_status enums (rdf_ops carries the WALK_IN_*
// values, rnp/rcs do not), so a shared union would be a lie and an enum-cast
// comparison against the full set is a hard error on two of the three schemas.
// The ADR-017 idiom.
// ══════════════════════════════════════════════════════════════════

import type { Agency } from '@usrp/shared-types';

export interface OwnershipQuery {
  readonly applicantId: string;
  readonly applicationId: string;
}

/** An application the given applicant genuinely owns. */
export interface OwnedApplication {
  /** DERIVED from which ops schema held the row — never from the request. */
  readonly agency: Agency;
  /** Raw status text — see the header for why it is not a typed enum. */
  readonly status: string;
}

export interface ApplicationOwnershipReader {
  /** null when no such application exists OR it belongs to someone else. */
  findOwnedApplication(query: OwnershipQuery): Promise<OwnedApplication | null>;
}
