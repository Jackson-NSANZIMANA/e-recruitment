# Secret Rotation — `.env.backup.20260827074511`

**Classification:** credential disclosure, treat as active
**Opened:** 2026-09-04
**Trigger:** a timestamped copy of a live `.env` (10,052 bytes) was tracked on `main` from 2026-08-27 to 2026-09-04
**Owner decision on record:** treat as an active security breach and rotate all environment secrets

---

## 1. What is actually known

Stated precisely, because a rotation driven by a vague claim gets argued with instead of executed.

**Known:** a file named `.env.backup.20260827074511`, 10,052 bytes, was committed to `main` and was readable by anyone with read access to the repository for eight days. It is still retrievable from history at any commit in that range.

**Deliberately not known:** its contents. The file was untracked without being read. Reading it to decide whether it "really" contained secrets converts a mechanical response into a judgement call, and the judgement is always made under time pressure by the person who least wants it to be a breach.

**Therefore assumed:** every key documented in `.env.example` (17,873 bytes) was present with a live value.

**Not sufficient to close this:** untracking the file (done), fixing `.gitignore` (done), or adding the CI gate (done). None of those invalidate a disclosed value. **Rotation is the only remedy.** A history rewrite reduces future exposure; it does not undo eight days of read access.

---

## 2. Rotation order, by blast radius

Rotate top-down. If you must stop partway, stopping after step 2 leaves the platform in a materially safer state than stopping after step 5.

### 1. Ed25519 JWT signing keys — **do this first**

Every service verifies officer tokens with the corresponding public key. A disclosed **private** key mints valid officer JWTs for RDF, RNP and RCS, and per ADR-016 those tokens are **non-revocable until expiry by design**. There is no revocation list to fall back on: rotation is the entire mitigation.

- Generate a new keypair, distribute the public key to all eleven services, cut over, retire the old key.
- Expect every officer to be signed out. That is correct and should not be engineered around.
- Audit `audit-service` for officer-token activity in the exposure window, particularly adjudication and final-decision events.

### 2. Database credentials

RLS is `FORCE`'d with `NOLOGIN` group roles, so a leaked application role does not grant a bypass principal — the ops-schema isolation holds. It does grant that role's full legitimate reach, which spans citizen PII across three agency schemas.

- Rotate the application role passwords and any migration/superuser role.
- Confirm the network path is unchanged (rotation is not a substitute for the DB being unreachable from outside the cluster).

### 3. NIDA gateway credentials

A government-to-government integration against the national identity authority. Disclosure here is an incident with an **external** counterparty, not just an internal one.

- Rotate, and notify the NIDA integration owner. Do not let the notification wait on the rotation completing.
- This is the item most likely to carry a legal reporting obligation under Law N° 058/2021. Confirm with the DPO rather than assuming.

### 4. HSM / PKI material

If any HSM PIN, slot credential, or wrapping key was present, rotate through the HSM's own procedure. Do not improvise this one; a wrong sequence here can render sealed data unrecoverable.

### 5. SMS provider credentials

OTP delivery for applicant authentication. A disclosed sending credential allows an attacker to send messages that appear to originate from the government, which is a phishing capability against citizens and should be treated as reputational as well as technical.

### 6. Kafka / event bus, object storage, and everything else in `.env.example`

Work the file top to bottom. Anything with a value gets rotated; anything that turns out to be unused gets deleted from the template so the next rotation is smaller.

---

## 3. Then close the loop

Closed or re-scoped in writing on 2026-10-16 (S00); the reasoning is in §5.

- [x] Every item in section 2 rotated, with a date and an operator name against each. **Re-scoped** (§5.2): no production secret has ever existed, so there is nothing in production to rotate. Production secrets are generated fresh in KMS (S07). Dev secrets are regenerated per developer (open action in §5.4).
- [x] `node scripts/check-tracked-secrets.mjs` green on `main`. Green on 2026-10-16. From S00 it runs on every CI run, `main` included.
- [x] `node scripts/check-tracked-secrets.mjs --selftest` green (proves the gate still fails when it should). Green on 2026-10-16, in CI from S00.
- [x] Gate wired as the **first** CI job, before `pnpm install`. Until S00 the gate was **not wired into backend CI at all**. It now runs as the first steps of the required `Security Scan` job, which never installs dependencies.
- [x] History rewrite planned and scheduled. **Not applicable**: the owner decided on 2026-10-16 not to rewrite (§5.3).
- [x] Audit review for the 2026-08-27 → 2026-09-04 window completed and signed off. **Not applicable**: in that window no deployment existed and there were no real officers, so there is no officer-token activity to review. Every audit log was a developer's local container.
- [x] DPO consulted on external notification obligations (NIDA, and any citizen-facing duty). **Not applicable** for the platform: no NIDA credential had been issued (G2G is mocks only) and no citizen record existed. This is the owner's position of 2026-10-16. When a DPO is appointed, they may review this note; nothing here forecloses that.

---

## 4. The process fix

A timestamped `.env` backup is not carelessness, it is what a rushed migration produces. The environment made it easy and nothing caught it.

What changed structurally:

1. `.gitignore` is now **deny-by-default** for `.env*` with `*.example` allowed back, so a suffix nobody anticipated is ignored by default rather than tracked by default.
2. `scripts/check-tracked-secrets.mjs` enforces it against the git **index**, because `.gitignore` does not survive `git add -f`.
3. The gate runs before dependency install, so it cannot be disabled by an unrelated build problem.
4. The gate is proven red-then-green by `--selftest`, so it cannot quietly degrade into `exit 0`.

The remaining gap was human: `main` accepted this commit **unreviewed and with no required status check**. S00 (2026-10-16) closed it: both `main` branches now require pull requests and green, up-to-date status checks, admins included. Force-push and deletion are refused.

---

## 5. Closure (S00, 2026-10-16)

### 5.1 The fact the closure rests on

No production environment has ever existed: no hosting, no production database, no KMS, no HSM. Also:

- no G2G authorisation has been issued (NIDA, NESA, HEC and RIB are mocks);
- no SMS provider has been contracted (`LogSmsChannel` only).

So whatever the August file held, it could only hold **development** values, or a credential someone pasted in by hand (see §5.4). This keeps §1's principle: the conclusion does not depend on reading the file.

### 5.2 Rotation, item by item

| §2 item | Resolution |
|---|---|
| 1. Ed25519 JWT signing keys | Dev: `bash scripts/generate-env.sh --force` mints two fresh, separate Ed25519 keypairs (JWT and QR) per developer. Production: no keypair has existed. S07 generates it in KMS, never derived from a dev value. |
| 2. Database credentials | Dev values are the `.env.example` placeholders for local containers. The production boot guard (`shared-config` selfcheck, run in CI) refuses dev secrets, placeholders, loopback and mocks, so a dev value cannot start production. Production credentials are created in S07. |
| 3. NIDA gateway credentials | Not applicable: no NIDA credential has been issued. Real G2G credentials (S12) are issued to production only. |
| 4. HSM / PKI material | Not applicable: no HSM exists; custody is an S07 owner decision. |
| 5. SMS provider credentials | Not applicable: no provider contract exists. |
| 6. Kafka, object storage, the rest of `.env.example` | Dev-only local containers. Regenerated with the dev `.env`, and recreated by `pnpm infra:reset`. |

### 5.3 Owner decisions recorded

- **History rewrite: no** (owner, 2026-10-16). Rotation covers the exposure because no production secret ever existed. A rewrite is a force-push of every branch, invalidates every clone, and would undo none of the eight days of read access. The file stays retrievable from history at `47d9ad3`…`c643006`, and that is accepted.
- **Repository visibility: stay public** (owner, 2026-10-16). See `docs/program/delivery-programme.md` §7.

### 5.4 Open actions (not closed by this note)

- **Each developer** regenerates their dev `.env` with `bash scripts/generate-env.sh --force` (add `pnpm infra:reset` if local DB passwords changed). This cannot be done for them: the `.env` is theirs.
- **The owner** confirms that no personal or third-party credential was ever pasted into a local `.env` in August, for example a cloud key or an SMS sandbox key. If one was, revoke it **at its provider**. §5.1's reasoning covers platform secrets, not credentials someone brought in from elsewhere.
