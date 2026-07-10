# Signed / verifiable slot-invitation QR slice

**Closes the ADR-008 follow-on seam.** The exam-slot QR minted by
`scheduling-service` was an opaque `randomBytes(32)` token — unforgeable only in
the sense of being unguessable, but **not offline-verifiable** and carrying no
claims. This slice makes it an **Ed25519-signed, self-contained credential** a
venue can verify without touching the platform. See
[ADR-009](./adrs/ADR-009-signed-verifiable-slot-invitation.md) for the decision.

## What changed, by layer

| Layer | Change |
|---|---|
| `@usrp/shared-types` | `SlotInvitationClaims` (PII-free claim contract); `qrSignedToken` added to `SlotAssignedEvent`. |
| `@usrp/shared-security` | `signSlotInvitation` / `verifySlotInvitation` (+`VerifySlotInvitationOptions`), reusing `signEd25519`/`verifyEd25519`/`canonicalJson`. Zero new deps. |
| `scheduling-service` config | Loads `QR_SIGNING_PRIVATE_KEY_B64` (base64 PKCS#8 PEM) + `QR_SIGNING_KEY_ID`; **derives** the public key at boot. |
| `scheduling-service` domain | `AssignSlotService` builds the PII-free claims and signs them via an injected `SlotInvitationSigner`; both `qrInvitationCode` (ticket id) and `qrSignedToken` go on the event. |
| `scheduling-service` HTTP | `GET /v1/slots/invitation-key` → `{keyId, algorithm, publicKeyPem}` for offline verification. (Previously routes-only.) |

## The two artifacts

- **`qrInvitationCode`** — the compact (≤64), unique **ticket id**. Unchanged: the
  `varchar(64) UNIQUE` DB key and the anchor `SignableFieldPayload.qrInvitationCode`
  binds physical-test scores to. *Identity.*
- **`qrSignedToken`** — `USRP-SLOT.v1.<base64url(canonicalJson(claims))>.<base64url(sig)>`.
  The credential encoded into the QR. *Authenticity + claims.* Verified offline
  with the published Ed25519 public key. Expires at end (UTC) of the exam day.

## Token format

```
USRP-SLOT . v1 . <base64url(canonicalJson(claims))> . <base64url(ed25519 sig)>
└──────── signed input ────────┘
```

The signature covers `USRP-SLOT.v1.<payload>`. `verifySlotInvitation` splits on
`.` (the namespace itself contains a `.`, so a valid token is exactly 4 parts),
re-derives the signing input, checks the signature, then the `expiresAt` window,
and returns the decoded claims or `null`. **It never throws.**

## Compliance

`SlotInvitationClaims` is a closed whitelist of opaque ids + the *public* venue +
timestamps — asserted PII-free by the proof. No raw home district, DOB, name, or
national id. Authenticity no longer depends on a central lookup.

## Delivery scope (owner decision, 2026-07-10)

**Transport-only, no migration.** `qrSignedToken` rides `SlotAssignedEvent` but is
not persisted (a signature won't fit `varchar(64)`, and there's no delivery
channel yet). The DB keeps the ticket id + `qr_invitation_issued_at`; the token is
self-verifying. Persistence in a wide column + applicant delivery are deferred to
when a notification/portal channel exists.

## Key management

Dev: base64 PKCS#8 PEM in an env var; the live selfchecks self-provision an
ephemeral keypair per run (a fixture, not a shared secret). **Production residual:**
the private key must be HSM/KMS-held (same class as the audit-immutability owner
key). `keyId` is embedded in every token to enable rotation; rotation mechanics
are not implemented this slice.

## Proofs

- `packages/shared-security/selfcheck/verify-slot-invitation.ts` — deterministic,
  infra-free; the authoritative gate for the crypto (round-trip, tamper,
  wrong-key, expiry, malformed, URL-safety, PII-free whitelist). Registered first
  in `run-selfchecks.sh`.
- `services/scheduling-service/selfcheck/verify-slot-assignment.ts` — extended:
  a live `SLOT_ASSIGNED` carries a token that verifies with the published key
  *as of exam morning*, binds to the ticket id, and is PII-free; tamper + wrong-key
  rejected.
- `services/application-service/selfcheck/verify-pipeline-e2e.ts` — full chain
  reaches `SLOT_ASSIGNED`; scheduling now mints a signed token. Now deterministic
  (the former "flake" was a real consumer-group defect, fixed this session — see
  `pipeline-convergence-fix.md`); gate is 17/17.

## Still-open seams (unchanged)

`DOCUMENT_REVIEW_AMBER` lane · downstream stages (`PHYSICAL_TEST_SCHEDULED → …`) ·
biometric stage 4 · signed-token **persistence + applicant delivery** (this slice
is issue + verify only) · production HSM key + rotation mechanics.

(`pipeline-flake hardening` is CLOSED — it was a real consumer-group defect, fixed
this session; see `pipeline-convergence-fix.md`. Gate now 17/17.)
