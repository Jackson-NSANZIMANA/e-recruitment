# ADR-031 — Operation-level permissions and separation of duties

**Status:** Accepted (BUILD-004 §D). **The role→permission table is a
provisional default awaiting ratification by the agencies** (see "Owner
decisions").

## Context
A valid officer token proved *who* and *which agency*, and that was all. Any
officer of an agency could record a medical verdict, sign a final decision,
accept an applicant, resolve a field-score conflict or enrol a device. The
only role-aware code was BUILD-001's campaign permissions. The audit called
this out: "a valid officer login is not automatically permission to …".

## Decision
1. **One permission catalogue and one role table** in `@usrp/shared-auth`
   (`permissions.ts`). Operations are verbs (`medical.review`,
   `decision.final`, `application.accept`, `field.conflict.resolve`, …).
   Roles: `agency_admin`, `reviewer`, `screening_officer`, `field_supervisor`,
   `medical_officer`, `adjudicator`, `decision_authority`, `dpo`.
2. **Fail closed.** Unknown role ⇒ nothing; no wildcard; no "superadmin"; a
   system token holds no human permission. Scope (agency) is never widened by
   a role — it still comes from the verified principal and FORCE'd RLS.
3. **Enforced twice.** The owning service is authoritative
   (`requireOfficerPermission` in every officer route: application-service,
   field-sync, biometric, identity); the edge registry declares the
   permission per operation and refuses before any upstream spend
   (`PERMISSION_DENIED`, audited as `EDGE_PERMISSION_DENIED`). The contract
   selfcheck fails if an officer operation declares no permission.
4. **Separation of duties, per application, inside the transition
   transaction** (same row lock, so it cannot be raced):
   - `FINAL_DECISION_EXCLUDES_MEDICAL_REVIEWER` (default **on**): the officer
     who moved the application into MEDICAL_REVIEW — read from the immutable
     history, which both BOARD and CERTIFICATE modes share — may not finalise.
   - `ACCEPT_EXCLUDES_FINAL_DECIDER` (default **off**): switchable policy.
   Refusal is a hold-safe `403 SEPARATION_OF_DUTIES` naming only the closed
   rule id, never the other person.
5. **No role holds both** `medical.review` and `decision.final`; the
   permission selfcheck asserts this by construction, so SoD cannot be
   defeated by assigning one role.

## Owner decisions required (engineers flag, they do not decide)
- Which post may sign final decisions and accept (`decision_authority` here).
- Whether `agency_admin` should ever decide candidates (default: no).
- Whether acceptance must be by a different person than the final decider.
- Whether any post may override SoD (none implemented; an override would need
  its own permission, reason and audit — deliberately not invented).
- Existing production officer accounts carry the old role set (`reviewer`
  and/or `agency_admin`); they lose decision rights until re-provisioned.

## Not in scope here
Officer lifecycle (create/disable/revoke accounts, role assignment API) and
device revocation remain open; this change only governs what a role may do.
