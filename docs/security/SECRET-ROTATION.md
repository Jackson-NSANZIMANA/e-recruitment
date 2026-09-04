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

- [ ] Every item in section 2 rotated, with a date and an operator name against each.
- [ ] `node scripts/check-tracked-secrets.mjs` green on `main`.
- [ ] `node scripts/check-tracked-secrets.mjs --selftest` green (proves the gate still fails when it should).
- [ ] Gate wired as the **first** CI job, before `pnpm install`.
- [ ] History rewrite planned and scheduled. Coordinate: it is a force-push and it invalidates every open branch and existing clone. The frontend repo's `tooling/repo-hygiene/PURGE-RUNBOOK.md` is a proven procedure whose approach ports directly.
- [ ] Audit review for the 2026-08-27 → 2026-09-04 window completed and signed off.
- [ ] DPO consulted on external notification obligations (NIDA, and any citizen-facing duty).

---

## 4. The process fix

A timestamped `.env` backup is not carelessness, it is what a rushed migration produces. The environment made it easy and nothing caught it.

What changed structurally:

1. `.gitignore` is now **deny-by-default** for `.env*` with `*.example` allowed back, so a suffix nobody anticipated is ignored by default rather than tracked by default.
2. `scripts/check-tracked-secrets.mjs` enforces it against the git **index**, because `.gitignore` does not survive `git add -f`.
3. The gate runs before dependency install, so it cannot be disabled by an unrelated build problem.
4. The gate is proven red-then-green by `--selftest`, so it cannot quietly degrade into `exit 0`.

The remaining gap is human: `main` accepted this commit **unreviewed and with no required status check**. Branch protection is tracked separately and is the reason a single unreviewed push could put a secret in a national repository.
