// ══════════════════════════════════════════════════════════════════
// background-vetting-service — criminal clearance by Irembo certificate
// (ADR-048 §2.3): the domain's shape, decoupled from the Irembo wire format.
// ══════════════════════════════════════════════════════════════════

/**
 * A certificate IN FORCE: Irembo returns every field.
 * The holder fields are TRANSIENT: compared in the binding rule, then discarded;
 * never stored, logged or emitted.
 */
export interface ClearanceCertificateInForce {
  readonly authentic: true;
  /** The certificate type (Irembo APPLICATION_CODE). */
  readonly type: string;
  /** ISO YYYY-MM-DD. */
  readonly issuedOn: string;
  readonly holderName: string;
  /** ISO YYYY-MM-DD. */
  readonly holderDob: string;
  /** The registry's own reference (REFERENCE_NUMBER). */
  readonly reference: string;
}

/**
 * A certificate that is NOT in force (expired or withdrawn). Irembo returns
 * STATUS and APPLICATION_CODE alone and withholds the holder's name, date of
 * birth, issue date and reference, so nothing here identifies the subject.
 * A clearance certificate is valid for three months, so this is the COMMON case.
 */
export interface ClearanceCertificateNotInForce {
  readonly authentic: false;
  readonly type: string;
}

/**
 * The two shapes the registry answers in, discriminated by `authentic`, so a
 * holder field can never be read off a certificate that does not carry one.
 */
export type ClearanceCertificate = ClearanceCertificateInForce | ClearanceCertificateNotInForce;

export type ClearanceLookup =
  | { readonly status: 'FOUND'; readonly certificate: ClearanceCertificate; readonly requestId: string }
  | { readonly status: 'NOT_FOUND'; readonly requestId: string };

/**
 * The registry could not be reached, timed out, answered 429/5xx, a
 * status:false that is not "not found", a truncated or reshaped body, or a
 * sandbox answer in production. An infrastructure fault, NEVER a statement
 * about the applicant: the event is redelivered and the check retried.
 */
export class ClearanceRegistryUnavailableError extends Error {
  constructor(
    message: string,
    readonly requestId: string,
  ) {
    super(message);
    this.name = 'ClearanceRegistryUnavailableError';
  }
}

/** The campaign policy's clearance rules. Until policy v2 (S12c) they come from configuration. */
export interface ClearancePolicy {
  /** Certificate types accepted as a criminal clearance (a configurable allowlist). */
  readonly allowedTypes: ReadonlySet<string>;
  /** Types that are a distinct "no record" certificate: the content is conclusive, no human step. */
  readonly noRecordTypes: ReadonlySet<string>;
  /** Days before the submission reference date within which the certificate must have been issued. */
  readonly validityDays: number;
}

/** Closed codes for a correctable failure. Never a value from the certificate. */
export type ClearanceFailureCode =
  | 'CERTIFICATE_NUMBER_MALFORMED'
  | 'CERTIFICATE_NOT_FOUND'
  | 'CERTIFICATE_NOT_VALID'
  | 'CERTIFICATE_WRONG_TYPE'
  | 'CERTIFICATE_EXPIRED'
  | 'CERTIFICATE_NOT_BOUND';

/**
 * Why a human must look (the amber queue reasons, ADR-048 §3).
 *
 * Declared in @usrp/shared-types because four artefacts enforce it — this
 * writer, the rls/0044 CHECK, application-service's queue allowlist and the
 * edge-gateway's checklist allowlist. Duplicating the union here is how the
 * three copies drifted apart in the first place; re-exported so every existing
 * import keeps working.
 */
export type { ClearanceReviewReason } from '@usrp/shared-types';

export const CLEARANCE_FAILURE_CODES: readonly ClearanceFailureCode[] = [
  'CERTIFICATE_NUMBER_MALFORMED',
  'CERTIFICATE_NOT_FOUND',
  'CERTIFICATE_NOT_VALID',
  'CERTIFICATE_WRONG_TYPE',
  'CERTIFICATE_EXPIRED',
  'CERTIFICATE_NOT_BOUND',
];
