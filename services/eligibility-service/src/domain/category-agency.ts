// ══════════════════════════════════════════════════════════════════
// eligibility-service — Category ↔ agency mapping (re-export)
//
// The mapping now lives in @usrp/shared-types as the platform-wide source
// of truth (the front-door application-service needs it to route a
// submission to the owning agency's ops schema). This module re-exports it
// so eligibility's existing import sites and public API stay unchanged.
// ══════════════════════════════════════════════════════════════════

export {
  ALL_CATEGORIES,
  CATEGORY_TO_AGENCY,
  agencyForCategory,
} from '@usrp/shared-types';
