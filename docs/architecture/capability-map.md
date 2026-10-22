# USRP capability map — the three applications

**Purpose:** the living answer to "what must exist before USRP can be
deployed", per application, with the state of each capability **as verified in
code** (not as remembered). Update it in the same commit as the code it
describes. Last verified: 2026-10-16 (S00), backend `main` `446f90b` plus
`feat/rehearsal` `8943aec` (ADR-035), frontend `feat/rehearsal` `c5bda85`
(frontend `main` `e053479` plus PR #27).

Counts and SHAs are not restated here. Every CI run writes them to the
**evidence bundle**: the `evidence-<sha>` artefact of the *Evidence bundle*
job, holding `evidence-<sha>.json` (operation inventory, proof and unit-test
counts with skipped checks named, lockfile hash, peer pin). Cite the bundle
for the commit you mean.

Legend: ✅ built and proven by a live selfcheck · 🟡 partial · ❌ missing ·
**(S)** built or changed in the 2026-10-13…15 session.

## 1. Applicant portal (citizen)

| Capability | State | Evidence / gap |
|---|---|---|
| Onboarding: National ID + DOB → phone → OTP | ✅ **(S)** | ADR-029; identity `applicant-auth.service.ts`; durable DOB lockout rls/0028; `verify-applicant-auth-slice.ts` §1–9 |
| Browse open campaigns, view detail | ✅ backend · 🟡 UI | public list/detail; portal campaign picker **(S)** in `apps/applicant-portal/src/routes/apply` |
| Apply to a chosen campaign (public code), idempotent | ✅ **(S)** | ADR-030; `verify-campaign-bound-submission.ts` |
| Policy version + evaluation date bound at filing | ✅ **(S)** | rls/0029 write-once; event `referenceDate`/`policyVersionId` |
| Upload documents (scanned, sealed, no verdict to citizen) | ✅ **(S)** | `verify-applicant-document-door.ts` (real ClamAV, MinIO) |
| Advisory document checklist | ✅ backend+edge **(S)** · ❌ screen | ADR-032 (RCS General Enlistee: A2 via NESA, no notarised degree); `verify-document-checklist.ts`; api-client hooks exist |
| Application list / status | 🟡 | list exists; no authoritative timeline projection (BUILD-005) |
| Exam invitation + QR in the portal (download PNG / print) | ✅ **(S)** | ADR-033; rls/0031; `verify-exam-invitation.ts`; portal `/applications/:id/exam-qr` (jsQR round-trip test) |
| Deferred scheduling retried (no venue yet / venue full) | ✅ **(S)** | application-service re-announce sweep, bounded and outbox-staged; `verify-slot-retry.ts` |
| Withdraw, erasure request | ✅ | ADR-020, ADR-015 |
| Real SMS delivery | ❌ known gap | `LogSmsChannel` only (provider not available); the portal is the QR channel meanwhile |
| USSD / kiosk channels | ❌ | channel enum only |

## 2. Administrative officer dashboard

| Capability | State | Evidence / gap |
|---|---|---|
| Campaign create / policy / sessions / publish / close / complete / cancel | ✅ backend+edge · ❌ UI | BUILD-001: real-PostgreSQL acceptance proven in CI (§4). The 7 operations are in the frontend registry (`packages/api-client/src/paths.ts`) as **untyped IDs**: no `operations/` function or `wire.ts` type yet (S05) |
| Operation-level permissions + separation of duties | ✅ **(S)** | ADR-031; role table awaits agency ratification |
| Application queues, detail, decision trail | ✅ reads · 🟡 UI | officer-console screens are thin |
| Medical review / final decision / accept / adjudicate | ✅ (permissioned, four-eyes) **(S)** | `verify-officer-lifecycle-slice.ts` |
| Officer lifecycle: create, assign posts, disable, revoke sessions | ✅ backend+edge **(S01)** · ❌ UI (S06) | ADR-036, rls/0033: 9 edge operations (`listOfficers`, `createOfficer`, `reissueOfficerActivation`, `releaseOfficerActivation`, `assignOfficerPosts`, `disableOfficer`, `enableOfficer`, `revokeOfficerSessions`, `activateOfficer`); one-time activation code **released once to a second administrator, never to the creator (ADR-036 Addendum A, S06)**; disable/post change ends an open browser session on the next request (`verify-officer-lifecycle.ts`); rehearsal staffs each agency through them |
| Device revocation, fleet list, venue-day assignment | ✅ backend + edge **(S09)** · ❌ UI | `field.device.manage` (field_supervisor, agency_admin); closed reason, final, audited; next score sync, next biometric evidence and enrolment refused (`pnpm rehearse --fleet`). Offline window: a device that never reconnects keeps its data until wiped (S15). ADR-036 addendum |
| Venue live counts (expected, admitted, physical, medical, conflicts, asOf) | ✅ backend + edge **(S09)** · ❌ UI | `getVenueLiveCounts`; same-transaction projection (rls/0036); rehearsal asserts it equals the engine |
| Funnel metrics, exception desk, stuck applications | ❌ | BUILD-006 |
| Audit browser | ❌ | audit-service is write-only |
| Emergency campaign suspension | ❌ | BUILD-006 |
| Notification monitoring / reconciliation | ❌ | BUILD-005 |
| Erasure (DPO) queue and decision | ✅ backend + edge **(S04)** · ❌ UI | ADR-039: `listErasureRequests`, `decideErasureRequest` (decline needs grounds; execute composed at the edge) |
| Agency-scoped admin campaign list/detail (occupancy), application search with cursor + total, venue roster | ✅ backend + edge **(S04)** · ❌ UI | ADR-039, rls/0035 (indexes only): `listAgencyCampaigns`, `getCampaignAdminDetail`, `searchApplications`, `getVenueRoster` (no names, no NIDs); `x-usrp-permission` / `x-usrp-outcomes` on every officer operation, enforced by the edge-contract selfcheck; `pnpm rehearse --roster` |

## 3. On-site officer tablet (installable PWA — decided)

| Capability | State | Evidence / gap |
|---|---|---|
| The tablet app itself | ❌ | no app in `e-recruitment-ui/apps`; `OFFLINE_CAPTURE_CAN_SYNC=false` |
| Officer login, device enrolment | ✅ backend+edge | |
| QR scan → single-use admission record | ✅ backend+edge **(S)** · ✅ console screen | BUILD-003, ADR-034: one admission per QR (DB-unique), national ID card bound, every scan logged; advances to PHYSICAL_TEST_SCHEDULED; field scores require it. Online only. |
| Biometric check-in | 🟡 evidence model live, on-device capture B2 **(B1)** | ADR-037, rls/0034: device-signed `USRP-BIO-EVIDENCE.v1` records (Ed25519, verified against `field_devices`), modes OFF/SHADOW/ADVISORY (pilot SHADOW), evidence never a verdict: `NO_MATCH`/`INCONCLUSIVE` → supervised manual identity (`confirmManualIdentity`, field supervisor), gate records `NATIONAL_ID_CARD+CARD_PORTRAIT` / `+SUPERVISOR`; `NIDA_PORTRAIT` fails closed; no image, frame or embedding accepted (`verify-biometric-evidence.ts`); edge `getBiometricPolicy`, `recordBiometricEvidence`, `getBiometricEvidence`, `confirmManualIdentity`; rehearsal records a SHADOW row for persona A. The server-side mock matcher is dev-only |
| Venue document clearing by the check-in post | ✅ backend+edge **(S)** · ❌ screen | ADR-032 `document.verify.venue` |
| Walk-in register / vet (RDF) | ✅ (permissioned) | |
| Physical test capture, signed, offline CRDT sync | ✅ service · ❌ client | field-sync-service; fixed metric schema for all agencies. `enrollFieldDevice`, `syncFieldScores` and `resolveFieldSyncConflict` are frontend registry IDs only (untyped) |
| Medical capture on the tablet | ❌ | console only |

## 4. Platform gates before any pilot

| Gate | State |
|---|---|
| BUILD-001 real-PostgreSQL acceptance + trusted-backend review | 🟡 Real-PostgreSQL acceptance is **proven in CI** on every run (`Proofs` job): P5–P17 control plane, the populated upgrade with twice-replayed RLS bootstrap, the live edge boundary and the real IAM → Edge → PostgreSQL flow. Open: the direct first-admin provisioner-auth proof, **skipped** in CI because `FIRST_ADMIN_DATABASE_URL` comes only through an approved secret channel; and the trusted-backend review. The build-001 doc's "remains unverified" section predates CI |
| Agency ratification of roles and SoD | ❌ `docs/compliance/authorization-ratification.md` |
| Security sign-off of the anonymous surface (4 → 7) | ❌ `docs/security/anonymous-surface-review.md` |
| CAPTCHA/WAF in front of onboarding; SMS cost cap | ❌ |
| Real G2G (NIDA/NESA/HEC/RIB) authorization | ❌ mocks only |
| Real biometric matcher or ratified manual-admission policy | 🟡 manual-identity policy built (ADR-037, owner decisions; DPO sign-off pending); on-device matcher B2, thresholds B3 |
| Backups/PITR, KMS keys, load and failure testing | ❌ |
| G1 supply chain: signed, scanned images with SBOMs | ✅ (S03, ADR-038 / ADR-FE-014) once the PRs merge and the first `v0.1.0-rc1` release is cut |

## 5. Rehearsal and evidence

| Capability | State | Evidence / gap |
|---|---|---|
| Synthetic rehearsal: `pnpm rehearse` | ✅ **(S00)** | ADR-035, `tools/rehearsal`: stages REH-RDF/RNP/RCS campaigns through the real control plane only (first-admin provisioner, then `/edge/v1/**` with CSRF and Idempotency-Key); same-day re-runs idempotent; refuses production and non-local targets. Frontend pair: rehearsal markers on campaigns and the Exam Pass, and the opt-in live journey `apps/applicant-portal/e2e/live-rehearsal.spec.ts` (`USRP_LIVE=1`) |
| CI evidence bundle | ✅ **(S00)** | `scripts/evidence-bundle.mjs`, *Evidence bundle* job; parser tests in `scripts/test/evidence-bundle.test.mjs` |
| Unit suites in CI | ✅ **(S03)** | Job `Unit tests (every package)` runs every package's `test` script and `pnpm test:scripts`; making it a required check is the owner's branch-protection step |
| Tracked-secrets gate in CI | ✅ **(S00)** | `scripts/check-tracked-secrets.mjs` selftest + check, first steps of `Security Scan` (no install) |
| Deployable images (12 services) | ✅ **(S03)** | ADR-038: digest-pinned, read-only/cap-drop-ALL capable, `HEALTHCHECK`, 232–243 MB (budget 300). CI `images` job: Trivy (CRITICAL/HIGH blocking, expiring exceptions), CycloneDX SBOM; on main pushed, cosign-signed (keyless) and SBOM-attested to GHCR |
| `GET /version` on every service | ✅ **(S03)** | shared-http; edge adds contract + policy hashes; deployment-hygiene proof checks it live |
| Release evidence bundle | ✅ **(S03)** · first tag pending | `scripts/release-bundle.mjs`, `release.yml` on `v*` (promotes signed digests, verifies, publishes `release-<tag>.json`); dry run on every PR |
| Platform from its images | ✅ **(S03)** | `infrastructure/images/rehearse.sh`: 12 service + 2 SPA images, `pnpm rehearse` and the live journey green (2026-10-19) |

## 6. Recommended build order from here

1. ~~**Officer lifecycle**~~ — delivered in the backend and edge (S01, ADR-036). Remaining: the staff-admin screens (S06); a token revocation list to close the one-hour residual.
2. ~~**BUILD-003 check-in & admission**~~ — single-use QR admission delivered (ADR-034). Biometric evidence and supervised manual identity delivered (B1, ADR-037). Remaining: venue document clearing inside the gate flow, on-device capture (B2), offline admission queue.
3. **Tablet PWA** on the field-sync contract.
4. **Admin dashboard** — campaign control plane (types the 7 campaign operations), queues, exception desk.
5. **BUILD-005** notification intents + citizen timeline; **BUILD-006** operations.
