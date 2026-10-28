// ══════════════════════════════════════════════════════════════════
// identity-service — NIDA domain model
//
// The domain's shape for a citizen record, decoupled from NIDA's wire
// format. Adapters translate the external representation into these
// types so the application core never depends on NIDA's HTTP contract.
// ══════════════════════════════════════════════════════════════════

import type { Gender } from '@usrp/shared-database';

/** Citizenship status value that permits recruitment. */
export const RWANDAN_CITIZEN = 'RWANDAN_CITIZEN' as const;

/** A verified citizen record as returned by NIDA's identity registry. */
export interface NidaCitizen {
  readonly fullName: string;
  readonly dateOfBirth: string; // ISO 8601 date, YYYY-MM-DD
  readonly gender: Gender;
  readonly homeDistrict: string;
  readonly homeProvince: string;
  // No phone: NIDA does not hold SIM-registration numbers (ADR-029). The
  // citizen states a phone and proves control of it with an OTP.
  readonly citizenshipStatus: string;
  /**
   * The ID CARD's expiry is past (dateOfExpiry). The identity itself is
   * still NIDA's; this flag does not block onboarding (default taken, owner
   * to confirm, ADR-047). Not stored.
   */
  readonly idDocumentExpired?: boolean;
}

/**
 * Outcome of a NIDA citizen lookup. Every result carries the
 * `nidaRequestId` so the verification is traceable back to the exact
 * G2G call in both systems' audit logs.
 */
export type NidaLookupResult =
  | {
      readonly status: 'FOUND';
      readonly nidaRequestId: string;
      readonly citizen: NidaCitizen;
      /**
       * The G2G subject hash — HMAC(NIDA-shared secret, NID) — that NIDA
       * used to resolve this citizen. It is the stable token other
       * government authorities (HEC/RIB) recognise for the same person, so
       * identity-service persists it (encrypted) to re-present later. The
       * raw NID never leaves the gateway; this hash is what does.
       */
      readonly nidaLookupHash: string;
      /**
       * Confidence of the identity match, when NIDA returns one. A pure
       * demographic lookup returns null; biometric 1:1 match (a later
       * pipeline stage, biometric-service) is what populates a score.
       */
      readonly matchConfidence: number | null;
    }
  | {
      readonly status: 'NOT_FOUND';
      readonly nidaRequestId: string;
    };
