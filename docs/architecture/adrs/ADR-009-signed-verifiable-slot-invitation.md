# ADR-009: the slot-invitation QR is an Ed25519-signed, offline-verifiable credential

**Status:** Accepted (2026-07-10)
**Owner sign-off:** Jackson NSANZIMANA (chose transport-only delivery this slice; persistence + applicant delivery deferred)
**Extends:** [ADR-008](./ADR-008-slot-assignment-scheduling-gate.md) (the scheduling gate that mints the invitation), [ADR-003](./ADR-003-crdt-offline-tablet-sync.md) (the Ed25519 device-signing primitive this reuses)

## Context

ADR-008 shipped the scheduling gate, but deliberately minted an **opaque
`randomBytes(32)` token** as the exam-slot QR and named a "cryptographically
signed/verifiable QR" as a follow-on. An opaque token has a real weakness: a
venue (often remote, intermittently offline) **cannot tell a genuine invitation
from a forged one without a live lookup** against the platform. It also can't
confirm *what* the QR asserts (which applicant, which venue, which day) — the
token carries no claims, only identity by reference.

The next stages depend on trusting that QR. `SignableFieldPayload` (in
`@usrp/shared-security`) — the physical-test field-score signature — **already
binds each score to `qrInvitationCode`**. If the QR isn't itself verifiable, that
binding anchors to an unauthenticated value.

## Decision

**The applicant's QR is a self-contained, offline-verifiable credential:
`SlotInvitationClaims` signed with Ed25519, distinct from the opaque ticket id.**

Two cleanly separated artifacts, not one:

1. **`qrInvitationCode`** — unchanged meaning: the compact (≤64), unique
   **ticket id**. It stays the `varchar(64) UNIQUE` DB key and the stable anchor
   that physical-test scores bind to. *Identity.*
2. **`qrSignedToken`** — the credential encoded into the QR the applicant
   presents. *Authenticity + claims.* Format (JWS-like, but zero-dep and
   Ed25519-only):

   ```
   USRP-SLOT.v1.<base64url(canonicalJson(claims))>.<base64url(ed25519 sig)>
   ```

   The signature covers `USRP-SLOT.v1.<payload>` (the header is bound too). A
   venue / biometric / physical-test stage verifies it with the scheduling
   **public key alone — no DB round-trip** — which is the whole point.

`SlotInvitationClaims` is **PII-free by construction** — a closed whitelist of
opaque ids + the *public* venue location + timestamps: `v, keyId, ticketId,
applicationId, applicantId, agency, campaignId, slotId, venueName, examDate,
reportingTimeHour, issuedAt, expiresAt`. Never the raw home district, DOB, name,
or national id. (The proof asserts the payload keys are exactly this set.)

### Why a compact custom format, not JWT/JOSE

Invariant #5 (minimal supply-chain surface): the crypto is pure `node:crypto`
Ed25519 via the existing `signEd25519`/`verifyEd25519`, and the canonical
serialization is the existing `canonicalJson`. No `jose`/`jsonwebtoken`
dependency. The token is URL/QR-safe (base64url + `.`), and `verifySlotInvitation`
**never throws** — malformed input, bad signature, wrong key, or an expired
window all return `null` (= reject), so callers treat verification as a total
function.

### Key management

- The scheduling private key is supplied **base64-encoded PKCS#8 PEM** in an env
  var (`QR_SIGNING_PRIVATE_KEY_B64`) so a multi-line PEM survives env transport;
  `QR_SIGNING_KEY_ID` names it. The public half is **derived at boot** and served
  read-only at `GET /v1/slots/invitation-key` (`{keyId, algorithm, publicKeyPem}`)
  for verifiers to fetch. `keyId` rides in every token so a verifier selects the
  right key across a rotation.
- **Residual (flagged, not resolved):** in production the private key MUST live in
  an HSM/KMS, not on a host filesystem — the same class of residual as the
  audit-immutability owner key. Key *rotation mechanics* (publishing multiple
  active public keys) are enabled by `keyId` but not implemented this slice.

### Delivery: transport-only this slice (owner decision)

`qrSignedToken` is added to `SlotAssignedEvent` and rides the backbone; it is
**not persisted** and there is **no schema change**. The DB already holds the
ticket id + `qr_invitation_issued_at`, and the token is self-verifying, so nothing
is lost. Persisting the token (a wide column) and delivering it to the applicant
are deferred until a notification/portal channel exists — a self-contained
credential in a varchar(64) column was never viable anyway (an Ed25519 signature
alone is ~86 base64url chars).

## Decisions locked (surfaced for sign-off)

- Ticket id (identity, DB key, score-binding anchor) is **separate from** the
  signed credential (authenticity). The event field `qrInvitationCode` keeps its
  meaning; `qrSignedToken` is new.
- Ed25519 + `canonicalJson`, zero new dependencies. Compact custom token, not JWT.
- Claims are a PII-free closed whitelist; verification is offline via a published
  public key.
- Invitation **expires at the end (UTC) of the exam day** (`expiresAt`);
  `verifySlotInvitation` enforces it.
- Transport-only delivery; no migration; persistence + applicant delivery deferred.

## Consequences

- Any downstream stage (biometric, physical-test field capture) can now
  authenticate an invitation offline before trusting `qrInvitationCode` — closing
  the loop `SignableFieldPayload` already assumed.
- Adds one read-only HTTP route to the previously routes-only scheduling service
  (public key distribution). No PII, no state.
- **Compliance:** the QR now provably carries no PII, and its authenticity no
  longer depends on a central lookup that could itself leak query patterns.

## Verification

- **`packages/shared-security/selfcheck/verify-slot-invitation.ts`** — the
  authoritative deterministic proof (no infra): sign→verify round-trip (claims
  survive by value), tampered payload / tampered signature / wrong public key all
  rejected, expiry enforced (accepted before, rejected after), malformed tokens
  rejected without throwing, token is URL/QR-safe, claims are the PII-free
  whitelist.
- **`verify-slot-assignment.ts`** (extended, live Kafka + PG) — a real
  `SLOT_ASSIGNED` carries a `qrSignedToken` that verifies with the service's
  published public key *as of exam morning*; claim `ticketId` binds to the row's
  `qrInvitationCode`; claims are PII-free; tamper + wrong-key rejected.
  (A real find surfaced here: seed exam dates in the past are correctly rejected
  as expired — verification is now clock-aware.)
- **`verify-pipeline-e2e.ts`** — the full chain reaches `SLOT_ASSIGNED` with
  scheduling minting a signed token. This proof is now deterministic (the former
  "flake" was a real consumer-group defect, fixed alongside this slice — see
  [pipeline-convergence-fix.md](../pipeline-convergence-fix.md)); the gate is
  17/17 green.
