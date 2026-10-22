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
exists, is active and holds exactly its posts. The dev seeder
remains for bootstrap only.

## Owner decisions (asked 2026-10-18, answered)
| Decision | Answer |
|---|---|
| May an `agency_admin` grant `agency_admin`? | **No.** Only the first-admin provisioner path creates an administrator. |
| May an `agency_admin` grant `decision_authority`? | **Yes, audited** (the role table stays provisional until ratified). |
| Initial credential delivery | **One-time activation code**, shown once, stored hashed, 24 h expiry; the officer sets the password through `activateOfficer`. No server-generated plaintext password anywhere. **Amended by Addendum A:** the code is released once to a *different* administrator, never to the creator. |

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

## S09 device management

*Addendum, 2026-10-21 (S09, rls/0036). Owner decision, settled.*

**Permission.** A new `field.device.manage`, granted to `field_supervisor` and
`agency_admin`, covers `listFieldDevices`, `assignDeviceToVenueDay` and
`revokeFieldDevice`. Enrolment (`field.device.enroll`) is unchanged and stays
with the screening officer, and so does the residual B1 recorded: a dishonest
gate officer can still enrol a key. The mapping is in the `permissions.ts` role
table comment. `getVenueLiveCounts` is read with `field.score.sync` or
`field.device.manage`.

**Revocation.**
- It requires a reason from a closed vocabulary (`LOST`, `STOLEN`, `COMPROMISED`,
  `RETIRED`, `OTHER`). There is no free text, so the audit stays PII-free.
- It is final: a trigger refuses to change the key, the agency, the enrolment
  record or a revocation. A replacement tablet enrols under a new device id, and
  enrolling a revoked id answers `409 DEVICE_REVOKED`.
- It is audited: `FIELD_DEVICE_REVOKED` is staged in the transactional outbox in
  the same transaction as the update (a narrow outbox policy admits only
  field-sync's two fleet actions) and relayed by field-sync's own relay.
- A device of another agency is a bare 404 and stays active.

**Offline exposure window.** Revocation takes effect on the device's *next
contact*: the next score sync and the next biometric evidence (both read
`revoked_at` on every record; the engine re-checks it), and any enrolment under
that id. A revoked device that never reconnects keeps its local data, its
enrolled key and whatever it captured until the device is wiped (S15 and the
operations runbook). Nothing reaches into the tablet. A request already in
flight when the revocation commits may still complete. Last-seen (below) tells a
supervisor whether a device is still in contact.

**Last seen.** `last_seen_at`, `last_seen_source` and `last_sync_at` are stamped
only by `public_core.touch_field_device`, after a *signed* contact from an active
device (a score sync past the signature check, or a verified evidence record).
They are monotonic (`GREATEST`) and a forged or revoked contact stamps nothing.

**Venue live counts.** `public_core.venue_day_counts` holds, per campaign,
district and exam date: expected (the roster), admitted, physical captured,
medical recorded, open conflicts and `as_of`. It is event-driven in the strict
sense that matters here: SECURITY DEFINER triggers on the roster
(`applications`), `gate_admissions` and `physical_test_scores` *recompute* the
venue's five counts in the same transaction as the event, so the projection can
neither lag nor drift, and a replay is harmless. It needs no message bus, so it
works under the in-memory dev bus too. Cost: admissions at one venue serialise
on one small row for the duration of their own transaction. Officers read their
own agency's rows through FORCE'd RLS and cannot write the table. Medical
recorded counts candidates with a score row carrying a fitness status; an
application's own medical review is not counted. A venue with no event yet
answers zeros with `asOf: null`.

## Addendum A (2026-10-21, S06) — four-eyes release of the activation code
**Status: accepted (owner decision, settled). Takes no new ADR number.**

### Problem
As first shipped, `createOfficer` and `reissueOfficerActivation` returned the one-time
activation code to the creating `agency_admin`. One administrator could therefore create
a `decision_authority` officer, redeem the code themselves and act as the second person
in a four-eyes decision (ADR-031). The S01 hand-off flagged this as a design residual.

### Decision
1. **Create and reissue never carry a code**, or anything it can be derived from. They open
   a *pending activation* and answer `{ outcome, officer }`; the officer row gains
   `activationState` (`PENDING_RELEASE | RELEASED | null`) and `releasableByYou`.
   The same holds at the iam-service route and at the edge projection (an upstream
   `activation` object is dropped, never relayed; allowlist test).
2. **The code does not exist until release.** A new operation `releaseOfficerActivation`
   (`POST /edge/v1/officers/activation/release`, `{ targetOfficerId }`, permission
   `officer.create`, CSRF, never retried) lets a **different** active `agency_admin` of the
   **same agency** perform a one-time release. The code is generated inside the
   database function at that moment, returned once, and stored only as SHA-256. The 24 h
   expiry runs from release; before release, the 24 h is the release window.
3. **Refusals** (ADR-039 style: a typed `error` code per HTTP status, no body detail):

   | Status | `error` | When |
   |---|---|---|
   | 403 | `SAME_ADMIN` | the actor created the account **or** last created/reissued this activation |
   | 404 | `NOT_FOUND` | absent, or in another agency (one answer, no cross-agency oracle) |
   | 409 | `ALREADY_RELEASED` | the code was already released: reissue instead |
   | 409 | `ACTIVATION_EXPIRED` | the release window passed: reissue instead |
   | 409 | `NOT_PENDING_ACTIVATION` | already activated, disabled, or no open activation |
   | 403 | `PERMISSION_DENIED` | not an active agency administrator |

   `SAME_ADMIN` is checked before `ALREADY_RELEASED`, so the creator never learns more than
   "not you". Both the creator and the latest reissuer are barred: the releaser must differ
   from every administrator who touched that activation, so one person cannot
   complete both halves.
4. **Reissue** invalidates any released but unredeemed code (the hash is cleared) and
   reopens the release window. `activate` additionally requires `released_at IS NOT NULL`.
5. **Audit**: `OFFICER_ACTIVATION_RELEASED` (actor = the releasing administrator; metadata:
   the issuing administrator's id, `grantsDecisionAuthority`). Create and reissue audits no
   longer claim a delivered code. PII-free as before.
6. **Schema** (rls/0033 edited in place, replay-safe; no new file or Drizzle migration;
   .ts mirror and 0004 snapshot updated): `officer_activation_codes` gains `created_by`,
   `released_at`, `released_by`; `code_hash` becomes nullable; a CHECK ties
   `code_hash IS NULL` to `released_at IS NULL` until redemption. Codes issued under the
   first S01 contract are voided on replay (hash cleared): they were visible to their
   creator and need a release by a second administrator. The private function
   `officer_private_issue_code` is dropped.
7. **UI contract (S06 frontend)**: the creating administrator sees "pending release by a
   second administrator"; a second administrator gets a release screen with copy and print;
   the creator never sees the code.
8. **Rehearsal**: seeds `<agency>.admin2` (dev-only local insert; the first-admin function
   provisions only the first administrator). The journey is: `rdf.admin` creates,
   `rdf.admin2` releases, the officer activates, `rdf.admin` assigns posts.

### Proof
`services/iam-service/selfcheck/verify-officer-lifecycle.ts` (live Postgres, iam-service,
edge): create answers carry no code at the edge **and** at iam-service; the creator is
refused (`SAME_ADMIN`); an administrator of another agency is refused (404, byte-identical
to a nonexistent officer); a reviewer is refused; a second administrator releases once;
a replay is refused (`ALREADY_RELEASED`); an unreleased account cannot be activated; the
released code activates and is single-use; a reissue voids a released code; after
creator-then-reissuer neither may release; the code appears in exactly one response and
nowhere in the database or outbox in plaintext.
`services/edge-gateway/test/officer-admin-projection.test.ts`: the allowlist.

### Residual
- **The releaser holds the code and knows the handle.** The anonymous `activateOfficer`
  takes only handle and code, so the releasing administrator could redeem it with a
  password of their choosing and control the account. Four-eyes here separates creator
  from code holder; it does not authenticate the redeemer. Mitigations: the releaser is
  recorded (`OFFICER_ACTIVATION_RELEASED`), the activation is recorded
  (`OFFICER_ACTIVATED`), and the officer's first login shows in `lastLoginAt`; the pilot
  procedure hands the printed code to the officer in person. Binding the redeemer (a
  second factor sent to the officer's own channel) is deferred.
- **Deadlock recovery.** If the releasing administrator reissues, neither they nor the
  creator may release. In a two-administrator agency the other one reissues again, after
  which the first can release. `activationState` is `EXPIRED` once the window passed,
  so a client can offer "reissue" rather than "wait".
- Rolling deploy: edge and iam-service must be upgraded together (the officer row gained
  two required fields).
Two administrators can still collude (that is the point of four-eyes, not a defect). A
single agency with one active administrator cannot onboard anyone until a second is
provisioned through the operator path; the pilot runbook must say so.
