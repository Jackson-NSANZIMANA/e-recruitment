# ADR-010: Field-Score Sync — Zero-Dep Vector-Clock Register, Device Registry, Hybrid Conflict Resolution

**Status:** Accepted
**Date:** 2026-07-10
**Refines:** ADR-003 (CRDT + Vector Clocks for Offline Field Tablet Sync)

## Context

Field officers score the physical test on tablets at exam venues, frequently **offline**. Scores must be device-signed (tamper-evident, non-repudiable), synced reliably later, and merged without stale-write overwriting or silent loss of an official result. ADR-003 accepted "CRDT + vector clocks + Ed25519 device signatures" but named the **Automerge** library and left the concrete mechanics (key custody, conflict policy, ownership) open. The building blocks now exist: `FieldScoreCapturedEvent`, the `physical_test_scores` table (`vector_clock jsonb`, `device_signature`, `signed_payload_hash`, `sync_conflict_detected`, `sync_conflict_resolution`, `captured_at`, `synced_at`), and the hand-rolled `signFieldScoreRecord`/`verifyFieldScoreRecord`/`SignableFieldPayload` primitive in `@usrp/shared-security`. This stage advances `PHYSICAL_TEST_SCHEDULED → PHYSICAL_TEST_COMPLETE`.

## Decisions

1. **Zero-dep hand-rolled vector-clock register — NOT the Automerge library** (refines ADR-003 §Decision). The platform is zero-runtime-dependency, and the score model is a *single logical register per application* (one official score, with corrective records), not a rich collaborative document — Automerge's CRDT document machinery is unwarranted weight and a large supply-chain surface at a national-security boundary. We implement causality with plain vector clocks (`Record<deviceId, counter>`) and the existing Ed25519 primitive. ADR-003's guarantees (convergence, stale-write rejection, device signing, immutability) are preserved; only the mechanism changes.

2. **Full device registry + server-side signature verification** (owner-approved). New `public_core.field_devices` (`device_id` PK, `public_key_pem`, `agency`, `enrolled_by`, `enrolled_at`, `revoked_at`). A device-enrollment path (officer/admin-authenticated) registers a tablet's Ed25519 public key. `field-sync-service` **verifies each record's `device_signature`** against the registry (`verifyFieldScoreRecord`) before accepting — realizing the non-repudiation the signing primitive was built for. An unenrolled/revoked device or a bad signature is rejected (never stored).

3. **Hybrid conflict resolution** (owner-approved). On sync, compare each incoming record's vector clock against the stored record for that application:
   - **Dominates** (incoming strictly ≥ stored on all axes, > on some) → supersede: append the new signed record as current (a valid correction). Stored history is never mutated (ADR-003 §4 immutability — corrections are new records).
   - **Dominated / equal** → stale or duplicate → no-op (idempotent; dedup by `signed_payload_hash`).
   - **Concurrent** (neither dominates) → **conflict**: keep BOTH signed records, set `sync_conflict_detected = true`, and HOLD the application (do not advance to `PHYSICAL_TEST_COMPLETE`) pending human adjudication. A separate officer-authenticated resolve endpoint records `sync_conflict_resolution` and selects the authoritative record. An official test result is never silently chosen.

4. **Ownership (keeps ADR-006).** `field-sync-service` owns the `physical_test_scores` store (its CRDT data): it verifies, merges, and writes the score rows (as `usrp_system_service` into the owning agency's ops schema), then emits `FIELD_SCORE_CAPTURED`. `application-service` consumes it and owns the **application-state** transition: advance `PHYSICAL_TEST_SCHEDULED → PHYSICAL_TEST_COMPLETE`, stamp `applications.physical_test_completed_at/_physical_test_score_id`. Only advances on a clean (non-conflicted) accepted score. **Biometric-pass is a precondition:** the advance requires `applicant_identities.biometric_verified_at` set (no physical-test completion for a check-in that failed biometrics).

5. **Idempotency / replay.** A resynced batch re-sends records; dedup is by `signed_payload_hash` (SHA-256 of canonical metrics) + `(application_id, device_id)` — an already-stored hash is a no-op. Safe under redelivery and re-upload.

## Build plan (slice 3)

- **Migration** `rls/0009_field_devices.sql`: `public_core.field_devices` + grants (system_service SELECT/INSERT; officer SELECT own-agency) + enrollment. Officers already have SELECT/INSERT/UPDATE on ops `physical_test_scores` via `rls/0001`; confirm system_service coverage.
- **`field-sync-service`** (new): device-enrollment endpoint (officer-auth) + batch sync endpoint (officer/device-auth) → per record: verify signature vs registry → vector-clock merge (pure domain) → write `physical_test_scores` / flag conflict → emit `FIELD_SCORE_CAPTURED`; conflict-resolve endpoint. Ports: `DeviceRegistry`, `FieldScoreStore`. Pure `mergeVectorClock`/`compareClocks` domain.
- **`application-service`**: new `field.score.captured` projection (own consumer group) → `applyPhysicalTestComplete` (advance + stamp + biometric-precondition check + history).
- **Proof** `verify-field-sync-slice.ts` (live PG): enroll device → sign a record → sync → stored + `FIELD_SCORE_CAPTURED` emitted; out-of-order/duplicate resync converges (idempotent); stale write rejected; concurrent captures → conflict flagged + application held; tamper/unenrolled-device rejected; resolve endpoint clears conflict; application-service advances to `PHYSICAL_TEST_COMPLETE`; biometric-precondition enforced. Register in `run-selfchecks.sh`.

## Consequences

- Non-repudiable, offline-first score capture with no silent loss of an official result; convergence under arbitrary sync order; zero new runtime dependencies.
- New human path: conflict adjudication (a held application awaiting an officer). This is the first deliberate human-hold in the funnel and connects to the broader adjudication work (amber lane, slice 5).
- Device lifecycle (enrollment/revocation, key rotation, HSM custody of device keys) is real operational surface; this slice does enrollment + revocation-aware verification; production key custody is deferred with the other HSM work.
