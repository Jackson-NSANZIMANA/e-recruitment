# ADR-036 — Officer lifecycle

**Status:** Accepted (S01, 2026-10-18). Owner decisions recorded below.
**Implements:** `rls/0033_officer_lifecycle.sql`, `services/iam-service`
(`/v1/officers/**`, `/v1/auth/officer/activate`), edge operations
`listOfficers`, `createOfficer`, `assignOfficerPosts`, `disableOfficer`,
`enableOfficer`, `revokeOfficerSessions`, `reissueOfficerActivation`,
`activateOfficer`.

## Context
ADR-031 gave the platform eight posts, operation-level permissions and
separation of duties, but nothing could *operate* them. The only ways to
create an officer were the dev seeder and the one-time first-admin
provisioner; nothing could assign a post, disable an account or end someone's
access. Officer bearer tokens last one hour and cannot be revoked (ADR-016);
browser sessions live in `public_core.edge_sessions`, which **copies** the
roles at login (ADR-028). `usrp_iam_service` is SELECT-only on
`officer_accounts` (rls/0010).

## Decision

### 1. Operations, agency-scoped from the principal
| Edge operation | iam-service route | Permission |
|---|---|---|
| `listOfficers` (GET `/edge/v1/officers`) | GET `/v1/officers` | `officer.read` |
| `createOfficer` (POST `/edge/v1/officers`) | POST `/v1/officers` | `officer.create` |
| `reissueOfficerActivation` (POST `/edge/v1/officers/activation/reissue`) | POST `/v1/officers/activation/reissue` | `officer.create` |
| `assignOfficerPosts` (POST `/edge/v1/officers/posts`) | POST `/v1/officers/posts` | `officer.posts.assign` |
| `disableOfficer` (POST `/edge/v1/officers/disable`) | POST `/v1/officers/disable` | `officer.disable` |
| `enableOfficer` (POST `/edge/v1/officers/enable`) | POST `/v1/officers/enable` | `officer.disable` |
| `revokeOfficerSessions` (POST `/edge/v1/officers/sessions/revoke`) | POST `/v1/officers/sessions/revoke` | `officer.sessions.revoke` |
| `activateOfficer` (POST `/edge/v1/auth/officer/activate`, anonymous) | POST `/v1/auth/officer/activate` | — (the activation code is the credential) |

The agency is never read from a path, query or body: it is the verified
principal's, re-checked against the actor's own database row. A target in
another agency answers `404 NOT_FOUND`, byte-identical to a nonexistent id.
Paths are exact (ADR-005), so the target travels in the body as
`targetOfficerId` (`officerId` is a forbidden request field at the edge,
because it names an actor).

### 2. Permissions (append-only in `shared-auth/permissions.ts`)
`officer.read`, `officer.create`, `officer.posts.assign`, `officer.disable`,
`officer.sessions.revoke` — granted to **`agency_admin` only**. They confer no
`campaign.*` and no decision power. `enableOfficer` reuses `officer.disable`
(the authority to suspend is the authority to lift a suspension);
`reissueOfficerActivation` reuses `officer.create` (it re-delivers the initial
credential of an account that has never been activated).

### 3. The write boundary: SECURITY DEFINER command functions
Every write is a function in `rls/0033`, owned by the NOLOGIN, BYPASSRLS
`usrp_officer_command_owner`, EXECUTE granted to `usrp_iam_service` only. The
iam-service adapter runs `SET LOCAL ROLE usrp_iam_service`, binds the verified
token subject to the transaction-local `usrp.officer_actor_id`, and calls the
function. Each function re-checks, from the database, that:

- the session login is `usrp_app` and the active role is `usrp_iam_service`;
- the actor bound in the transaction equals the actor argument;
- the actor is an **active `agency_admin` of the requested agency** — so a
  disabled administrator holding a still-valid one-hour token can do nothing.

As with BUILD-001 (rls/0027), the transaction-local actor is a guard against
substitution, not an independent identity proof: `usrp_app` can set custom
settings, so the authenticated service remains the trust boundary for *who*.

### 4. Guards, enforced in the function (and mirrored in the pure domain)
- same agency only (cross-agency target ⇒ `NOT_FOUND`);
- no self-modification of posts, status or sessions (`SELF_MODIFICATION`);
- cannot disable the last active `agency_admin` of an agency
  (`LAST_ACTIVE_ADMIN`, checked under a per-agency advisory lock, before the
  self check so the sole administrator is told the real reason);
- `agency_admin` is **not an assignable post** (`AGENCY_ADMIN_NOT_ASSIGNABLE`).
  Posts assignment preserves an existing `agency_admin` membership and can
  never add one; an administrator is removed by disabling the account;
- unknown posts, duplicate posts and an empty post set are refused
  (`UNKNOWN_POST`, `INVALID_POSTS`); assignable posts are `reviewer`,
  `screening_officer`, `field_supervisor`, `medical_officer`, `adjudicator`,
  `decision_authority`, `dpo`;
- reasons are **closed codes** per operation (`INVALID_REASON` otherwise), so
  every audit payload is PII-free by construction.

Separation of duties (ADR-031 §4) stays per application, inside the transition
transaction. Holding several posts does not weaken it, and nothing here can
switch it off.

### 5. Access ends on the next request
`disableOfficer` and `assignOfficerPosts` revoke every live edge session of
the target **in the same transaction** (`revoked_reason` `ACCOUNT_DISABLED` /
`POSTS_CHANGED`; the sealed upstream credential is blanked exactly as logout
does). `revokeOfficerSessions` does the same with `SESSIONS_REVOKED`. The edge
resolves the session row on every request, so the very next request from an
already-open browser answers `401 { reason: "revoked" }`. IAM login already
refuses any account whose status is not `active` (proved again by the
selfcheck). A posts change that leaves the post set unchanged revokes nothing.

**Residual (for the DPIA).** The officer's upstream bearer token, already held
*by the edge* inside the revoked session row, stays cryptographically valid
until its `exp` — at most **one hour** (ADR-016). It is not reachable: the row's
sealed copy is blanked, the browser never held it, and no browser can present
a revoked handle. A token exfiltrated *before* revocation (edge memory or a
compromised upstream) would remain usable against the services that verify
signatures only, for at most that hour. The officer-admin commands themselves
are not exposed to that residual: they re-read the actor's status and roles
from the database on every call (proved: a disabled administrator's unexpired
token gets `403` from iam-service). Closing the residual for all services
needs a revocation list or shorter tokens with refresh; that is deferred.

### 6. Initial credential: one-time activation code (owner decision)
`createOfficer` creates the account in status **`pending`** with a
non-verifiable credential sentinel, and returns a **one-time activation code**
exactly once: 20 symbols from a 32-symbol alphabet (100 bits) generated by
`pgcrypto.gen_random_bytes`, shown as `XXXXX-XXXXX-XXXXX-XXXXX`. Only its
SHA-256 is stored (`public_core.officer_activation_codes`, FORCE'd RLS, no
grant to any login role); it expires after **24 hours** and is single-use. A
fast hash is sufficient because the code is high-entropy and short-lived; the
password chosen at activation is stored with scrypt.

The officer redeems it at `activateOfficer` with their handle, the code and a
new password (12–256 characters). Unknown handle, wrong, expired, used code,
or an account that is not `pending` all answer one indistinguishable
`401 ACTIVATION_REJECTED`; the edge rate-limits per handle and per client with
the login limit. `reissueOfficerActivation` replaces the code of an account
that has never been activated (a lost or expired code); it cannot reset the
password of an activated account. **No plaintext password is generated by the
server, stored, logged or emailed anywhere.** The code never appears in an
audit event or a log.

### 7. Audit
Every command stages exactly one `AUDIT_ENTRY` (`entityType: OFFICER`, actor,
target, agency, action, closed reason code, posts) into the transactional
outbox (producer `iam-service`) in the same transaction as the change:
`OFFICER_CREATED`, `OFFICER_POSTS_ASSIGNED` (with `grantsDecisionAuthority`),
`OFFICER_DISABLED`, `OFFICER_ENABLED`, `OFFICER_SESSIONS_REVOKED`,
`OFFICER_ACTIVATION_REISSUED`, `OFFICER_ACTIVATED`. An unchanged or refused
command stages nothing. Payloads never carry a credential, code, code hash or
password; the handle is not PII here and is still omitted from events.

### 8. Listing
`listOfficers` returns, for the actor's agency only: officer id, handle,
posts, status (`active | disabled | pending`), created, activated, last login,
and the activation expiry of a pending account. Never a credential or a code
hash; the edge rebuilds the answer from an allowlist. `last_login_at` is
stamped by a narrow function on each successful login.

### 9. Rehearsal
`tools/rehearsal` gains a `staff` step: after signing in as the agency
administrator it creates each scenario's station officers **through these
operations** (create → activate with the documented dev password →
assign posts when they differ; enable / reissue to recover an earlier run),
then lists the agency's officers and fails unless each scenario officer
exists, is active, holds exactly its posts and can sign in. The dev seeder
remains for bootstrap only.

## Owner decisions (asked 2026-10-18, answered)
| Decision | Answer |
|---|---|
| May an `agency_admin` grant `agency_admin`? | **No.** Only the first-admin provisioner path creates an administrator. |
| May an `agency_admin` grant `decision_authority`? | **Yes, audited** (the role table stays provisional until ratified). |
| Initial credential delivery | **One-time activation code**, shown once, stored hashed, 24 h expiry; the officer sets the password through `activateOfficer`. No server-generated plaintext password anywhere. |

## Consequences
- ADR-031 can be operated; S06 builds the staff screens on these operations.
- A handle is unique platform-wide, so `HANDLE_TAKEN` reveals that a handle
  exists in some agency. Handles are not secret; this is accepted.
- An administrator cannot demote another administrator except by disabling
  the account; adding a second administrator still needs the operator path.
- Revoking one's own sessions is refused for uniformity; an officer ends their
  own session by logging out.

## Not in scope
MFA, lockout, SSO/IdP, password reset of an activated account, a token
revocation list (the one-hour residual), and the staff-admin UI (S06).
