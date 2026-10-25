# S12b — Criminal clearance by Irembo certificate, and SMS (backend)

**M3 · backend · depends on S12a (the simulator module interface, persona catalogue and `shared-identity-match`). The Twilio half can start before S12a merges.** · Branch `feat/s12b-clearance-sms` · Reserved: **ADR-048** (finalise it), **`rls/0040_clearance_certificates.sql`**

## Why
The owner chose the real clearance flow (ADR-048 §2.3): the citizen requests a criminal-record certificate on IremboGov, gives us the application number, and we verify it and bind it to their NIDA identity. Sign-in cannot run in production without a real SMS adapter, because `LogSmsChannel` is refused by the boot guard. Twilio is the sandbox operator, and the real operator follows the MTN/Airtel contract.

## Read first
- ADR-047, ADR-048, ADR-030, ADR-032 and ADR-021.
- The S12a hand-off.
- `services/background-vetting-service/src/**` (RIB port and adapter, events).
- `packages/shared-sms/src/**`.
- identity-service and notification-service SMS wiring.
- `production-guard.ts`.
- The RLS command-function pattern in rls/0033 and rls/0034.

## Privacy and secrets (mandatory)
- The certificate sample in sandbox-demo is a **third person's**: use its shape only, with no value anywhere.
- **Twilio credentials** are the owner's. They are read from an untracked env file whose path the owner gives (`SANDBOX_TWILIO_ENV_FILE`), never from sandbox-demo/e-recruitment.md, and never echoed. Real sends happen only when `SANDBOX_SMS=twilio`; the default is the emulator.

## Delivers
1. **`irembo-certificates` simulator** in S12a's harness: the exact envelope (`status`, `data.{ISSUED_ON, STATUS, REFERENCE_NUMBER, SIGNED_BY, DATE_OF_BIRTH, APPLICATION_CODE, NAME}`, `responseCode`, Kinyarwanda `message`, `responseEncrypted`, `traceId`). Its certificates belong to the synthetic personas:
   - clean clearance;
   - a clearance that carries a record;
   - wrong type (an equivalence certificate);
   - stale (issued too long ago);
   - name partial, name mismatch, DOB mismatch;
   - not found;
   - each behaviour profile.
2. **`ClearanceCertificateGateway` port and `IremboCertificateGateway` adapter**, with the transport separate from the mapping. The RIB-by-hash adapter stays behind the same port.
3. **Clearance domain** (ADR-048 §2.3):
   - number format validation;
   - the ordered checks: authentic, allowed type from campaign policy, validity window, then `bindCredential`;
   - `REVIEW` for content where the type can carry convictions;
   - outages yield PENDING and are retried, never negative.

   It emits the existing vetting events, with the source recorded.
4. **`rls/0040`:** append-only `clearance_certificate_verifications` per agency, written only through a SECURITY DEFINER command function. It stores no name or DOB, and the reference is held as HMAC plus its last 4 characters.
5. **Contract:** submission carries `clearanceCertificateNumber` (or a follow-up `attachClearanceCertificate` operation, whichever ADR-048 finalises). The edge records it with `x-usrp-permission` and `x-usrp-outcomes` where it's an officer operation; the citizen operation has a session-scoped `x-usrp-outcomes`. The document checklist shows clearance as outstanding until it's verified. **The frontend follow-up** (apply wizard field, checklist state, citizen-safe "does not match your identity" copy in rw/en/fr) is listed in the hand-off for the next frontend session.
6. **SMS:**
   - `sms-twilio` emulator in the harness: Twilio `Messages.json` form API, SIDs, status progression and an inbox file;
   - `TwilioSmsChannel` in `shared-sms`: E.164 normalisation for `07xxxxxxxx`, basic auth, a timeout, idempotent retries with a message key, status callback verification (`X-Twilio-Signature`), a per-day **cost cap** and a per-number rate limit;
   - the boot guard accepts `TwilioSmsChannel` in sandbox and production; `LogSmsChannel` stays refused.
7. **Officer queue reasons:** `CLEARANCE_CONTENT_REVIEW` and `IDENTITY_NAME_PARTIAL` (from S12a's binding) reach the amber queue read model. S06's queue shows them, and that frontend part goes in the hand-off.

## Owns
- `services/background-vetting-service/**`
- `rls/0040`
- `packages/shared-sms/**`
- SMS wiring in identity-service and notification-service
- `tools/g2g-sandbox/simulators/{irembo-certificates,sms-twilio}/**`
- ADR-048 (finalise; S12a has written §2.1–2.2)
- shared files, append-only

## Quality bar
- **Each clearance persona lands in its correct outcome on the sandbox**: the rehearsal scenario `clearance-matrix`.
- With `SANDBOX_SMS=twilio` set **locally by the owner only**, one OTP reaches the owner's verified phone. Report only that it was delivered, never the number.
- **CI uses the emulator only.**
- `/security-review` is mandatory (secrets, webhook signature, cost cap, personal data).

## Exit gate
- [ ] Clearance flow merged with rls/0040 and proofs; the clearance matrix passes.
- [ ] `TwilioSmsChannel` and the emulator are merged; identity and notification boot with `USRP_ENVIRONMENT=sandbox` and `NODE_ENV=production`.
- [ ] CI green on the PR head; ADR-048 Accepted; capability map and status board updated.
- [ ] A hand-off for the frontend covers the clearance field, checklist, copy and amber reasons.

## Owner decisions (defaults if not answered)
- **Validity window:** default 90 days before submission.
- **Exact Irembo `APPLICATION_CODE` for criminal-record certificates:** a configurable allowlist; the sandbox placeholder is clearly named. *Ask RIB/Irembo.*
- **Is there a distinct "no record" certificate type?** If not, content review is human (REVIEW).
- **Daily SMS cost cap for the sandbox:** default 50 messages per day.

## Session starter
```text
You are a principal backend engineer on USRP (Rwanda's national RDF/RNP/RCS e-recruitment platform). Backend: ~/Documents/projects/e-recruitment-software/e-recruitment.

This is session S12b — Criminal clearance by Irembo certificate, and SMS. Read your kit e-recruitment/docs/program/sessions/S12b-irembo-clearance-and-sms.md, then ADR-047 and ADR-048, the S12a hand-off, docs/program/ROADMAP.md §8.4, README.md and quality-workflow.md, and follow them.

Goal: an irembo-certificates simulator on the real envelope, a ClearanceCertificateGateway with ordered checks (authentic, allowed type, validity window, identity binding) that never turns an outage into a negative verdict, rls/0040 append-only verifications with no name or DOB stored, the clearance number in the submission contract, a Twilio emulator plus a production-grade TwilioSmsChannel (E.164, signature-verified callbacks, cost cap) accepted by the boot guard, and amber-queue reasons for content review and partial names.

PRIVACY AND SECRETS (mandatory): the certificate sample in sandbox-demo belongs to a third person, so use its shape only. Never read credentials from sandbox-demo/e-recruitment.md; Twilio credentials come only from the owner's untracked env file, and real sends only with SANDBOX_SMS=twilio, locally. Use ADR-048 and rls/0040 only. /security-review is mandatory. Work in your own worktree under ~/Documents/projects/e-recruitment-software/worktrees/, use your own database and ports 50xx (S12a uses 49xx), never kill TTY processes. Done = CI green on the PR head, the clearance matrix passing, status board and capability map updated, frontend hand-off.
```
