# USRP capability map — the three applications

**Purpose:** the living answer to "what must exist before USRP can be
deployed", per application, with the state of each capability **as verified in
code** (not as remembered). Update it in the same commit as the code it
describes. Last verified: 2026-10-15, backend branch
`feat/build-002-004-onboarding-binding-permissions`, frontend branch
`feat/citizen-onboarding-campaign-apply-permissions`.

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
| Campaign create / policy / sessions / publish / close / complete / cancel | ✅ backend+edge · ❌ UI | BUILD-001 (acceptance pending); 7 edge ops not in api-client (drift findings) |
| Operation-level permissions + separation of duties | ✅ **(S)** | ADR-031; role table awaits agency ratification |
| Application queues, detail, decision trail | ✅ reads · 🟡 UI | officer-console screens are thin |
| Medical review / final decision / accept / adjudicate | ✅ (permissioned, four-eyes) **(S)** | `verify-officer-lifecycle-slice.ts` |
| Officer lifecycle: create, assign posts, disable, revoke sessions | ❌ | only the first-admin provisioner script; **blocks operating ADR-031** |
| Device revocation | ❌ API | registry honours `revoked_at`; nothing can set it |
| Funnel metrics, exception desk, stuck applications | ❌ | BUILD-006 |
| Audit browser | ❌ | audit-service is write-only |
| Emergency campaign suspension | ❌ | BUILD-006 |
| Notification monitoring / reconciliation | ❌ | BUILD-005 |
| Erasure (DPO) queue and decision | ✅ backend (`dpo` role) · ❌ UI | |

## 3. On-site officer tablet (installable PWA — decided)

| Capability | State | Evidence / gap |
|---|---|---|
| The tablet app itself | ❌ | no app in `e-recruitment-ui/apps`; `OFFLINE_CAPTURE_CAN_SYNC=false` |
| Officer login, device enrolment | ✅ backend+edge | |
| QR scan → single-use admission record | ✅ backend+edge **(S)** · ✅ console screen | BUILD-003, ADR-034: one admission per QR (DB-unique), national ID card bound, every scan logged; advances to PHYSICAL_TEST_SCHEDULED; field scores require it. Online only. |
| Biometric check-in | 🟡 | service exists; matcher is a **mock that always passes** |
| Venue document clearing by the check-in post | ✅ backend+edge **(S)** · ❌ screen | ADR-032 `document.verify.venue` |
| Walk-in register / vet (RDF) | ✅ (permissioned) | |
| Physical test capture, signed, offline CRDT sync | ✅ service · ❌ client | field-sync-service; fixed metric schema for all agencies |
| Medical capture on the tablet | ❌ | console only |

## 4. Platform gates before any pilot

| Gate | State |
|---|---|
| BUILD-001 real-PostgreSQL acceptance + trusted-backend review | ❌ pending (see build-001 doc) |
| Agency ratification of roles and SoD | ❌ `docs/compliance/authorization-ratification.md` |
| Security sign-off of the anonymous surface (4 → 7) | ❌ `docs/security/anonymous-surface-review.md` |
| CAPTCHA/WAF in front of onboarding; SMS cost cap | ❌ |
| Real G2G (NIDA/NESA/HEC/RIB) authorization | ❌ mocks only |
| Real biometric matcher or ratified manual-admission policy | ❌ |
| Backups/PITR, KMS keys, load and failure testing | ❌ |

## 5. Recommended build order from here

1. **Officer lifecycle** (create, assign posts, disable, revoke; audited; `agency_admin`) — without it the permission model cannot be operated.
2. ~~**BUILD-003 check-in & admission**~~ — single-use QR admission delivered (ADR-034). Remaining: venue document clearing inside the gate flow, biometric evidence per attempt, offline admission queue.
3. **Tablet PWA** on the field-sync contract.
4. **Admin dashboard** — campaign control plane (closes the 7 drift findings), queues, exception desk.
5. **BUILD-005** notification intents + citizen timeline; **BUILD-006** operations.
