# ADR-053 — Bind host and the exposure policy

**Status:** Accepted · 2026-11-01 (defect-closure session D0) · closes evaluation 2026-10-29 defect **D9**
**Deciders:** platform owner (2026-11-01, §2: loopback default + announced LAN opt-in)
**Relates to:** ADR-028 edge tier, ADR-047 G2G production sandbox, ADR-040 deployment topology (S07), ADR-FE-016 / S08 Field Station
**Migration:** none

## 1. Context

`startHttpServer` defaults its bind host to `'0.0.0.0'` (`packages/shared-http/src/server.ts`). No service passes `host`. On a laptop running `pnpm sandbox:full`, **all thirteen processes are reachable from the venue or café network** — the edge, the identity door, the officer service, the field-sync write path. The G2G simulators are the only components that bind loopback correctly.

Two things are true at once, and the first is why this needs an ADR rather than a one-line change:

1. **Open by default is wrong.** Exposure must be a decision, not an inheritance. The system holds citizen identity, OTPs and officer credentials; the sandbox is the same code as production.
2. **Loopback-only is also wrong.** The M2 exam-day rehearsal is driven from **Galaxy Tab A7–A10 over the venue network** (ROADMAP §8.2, S08 kit). A blanket loopback bind makes the rehearsal impossible — and the flag will then be added quietly by whoever hits the wall, at 2 a.m., without a proof.

The defect is therefore not "the edge listens on all interfaces". It is **"exposure is silent, and nothing distinguishes the laptop from the venue."**

## 2. Owner decisions (2026-11-01)

| Decision | Taken |
|---|---|
| Default | **Loopback**, everywhere, for every process. |
| Opening it | **Explicit**, edge-only, and it announces itself on screen and in the log. |
| Production | `HTTP_BIND_HOST` is **required**; absent, the process refuses to boot (naming the variable) rather than silently binding a loopback nobody can reach inside a container. |
| The dangerous pair | LAN exposure **cannot** be combined with real SMS. Enforced in the launcher, not in a runbook. Narrowed by the 2026-11-05 amendment (§3.5): one acknowledged exception for the app-proxy `--lan`, never for the raw edge. |

## 3. Decision

### 3.1 One resolver, one rule

`@usrp/shared-config` exports `resolveHttpBindHost(serviceName)`:

1. `HTTP_BIND_HOST` set → validated as an IP literal, used;
2. production (`NODE_ENV=production`) and unset → **boot fails**, message names `HTTP_BIND_HOST` and the service (the `assertProductionSecrets` idiom);
3. otherwise → `127.0.0.1`.

Every entrypoint passes `host` explicitly. `shared-http`'s `'0.0.0.0'` default is **deleted**, so the next service cannot inherit exposure by accident.

### 3.2 Containers state their intent

`infrastructure/docker/docker-compose.tier{1,2}.yml` set `HTTP_BIND_HOST=0.0.0.0` per service. A static selfcheck walks the compose files and fails if a service has no explicit value — a container that binds loopback is a service nobody can call, and it should be caught in CI, not in staging.

### 3.3 The sandbox is loopback, and the venue is a decision

`pnpm sandbox:full` starts everything on loopback. `SANDBOX_EXPOSE_LAN=1`:

- binds **the edge only** — no other process;
- prints the LAN URL and a **warning banner in the `sandbox:full` status output** (the same surface that prints the SMS mode and the memory line), so exposure is never invisible;
- emits a structured log line `edge_exposed_on_lan` with the interface address, once, at boot;
- **refuses to run together with `--real-sms`** (`die`, exit non-zero). A synthetic-population identity door reachable from venue Wi-Fi *with live Twilio behind it* is the one accident that would end the programme; it becomes unrepresentable rather than discouraged.

### 3.4 The proof

`verify-bind-exposure.ts` (zero infrastructure where possible, live where needed):

1. enumerate every listening TCP socket of the sandbox PIDs; assert **loopback only** unless the flag is set;
2. with the flag, assert exactly one non-loopback listener and that it is the edge's port;
3. assert both compose files set `HTTP_BIND_HOST` for every service;
4. assert `SANDBOX_EXPOSE_LAN=1` + real SMS exits non-zero, that `--lan --real-sms` is refused without the
   acknowledgement, and that the acknowledged path narrows `LAN_APPS` to the applicant portal (§3.5);
5. assert a production boot without `HTTP_BIND_HOST` fails with the right message.

### 3.5 Amendment, 2026-11-05 — the acknowledged `--lan-real-sms` exception

**Decider:** platform owner, 2026-11-05. **Status:** accepted, narrows §3.3's last bullet.

§3.3 was written when `SANDBOX_EXPOSE_LAN=1` was the only way to reach the sandbox from the venue, and it
binds **the edge itself** — the identity door, in plain HTTP. `--lan` is a later and different mechanism:
`full.sh` serves the three apps over TLS from a private-IP-only CA and `unset`s `SANDBOX_EXPOSE_LAN`, so the
edge, the services and the data never leave loopback. The blanket refusal treated the two as one thing, and
so forbade a combination whose stated danger does not apply to it.

The danger §3.3 names — "live Twilio behind a door on venue Wi-Fi" — is in any case already unrepresentable
one layer down, and not by this flag. `create-sms-channel.ts` wraps the real channel in
`AllowlistSmsChannel`, whose allowlist is built from `TWILIO_TO` (`sandbox.ts`, `SANDBOX_SMS_ALLOWED_TO`):

```ts
if (destination === null || !this.#allowed.has(destination)) return 'FAILED';
```

The refusal happens **before the provider is called**. A stranger on the venue network cannot cause this
sandbox to text them, so they cannot receive an OTP and cannot onboard.

**What is decided.** `--lan-real-sms` (or `SANDBOX_I_ACCEPT_LAN_SMS=1` alongside `--lan --real-sms`) permits
the pair, under three conditions:

1. **Only the app proxy.** The exception applies to `--lan`. `SANDBOX_EXPOSE_LAN=1` with `SANDBOX_SMS=twilio`
   stays refused in the launcher (`sandbox.ts`), unconditionally and with no flag that lifts it.
2. **The applicant portal alone leaves loopback.** `LAN_APPS` narrows to `applicant-portal:4930`; the officer
   console and field station keep staff credentials on loopback. Only the citizen journey needs a phone.
3. **It announces itself.** A yellow banner states what is exposed, that Twilio is live and allowlisted, and
   that a bystander can still spend the daily cap and ring the owner's number.

**Residual risk, accepted knowingly:** anyone on that network can reach the portal, consume `SMS_DAILY_CAP`
and trigger texts to the owner's own number within `PerNumberLimiter`'s window; and the owner's private
persona (ADR-047 §3.5) is in a population reachable from it. The mitigation is operational — do not leave
this boot unattended — because the alternative is the 2 a.m. undocumented flag §1 warns about.

## 4. Rejected alternatives

| Alternative | Why not |
|---|---|
| **Hard loopback, no switch** | Blocks the M2 rehearsal (tablets over the venue network). The switch would be added later, undocumented and unproven. |
| **A reverse proxy on the LAN, every service loopback** | Correct in production, and the eventual answer (ADR-040), but it needs TLS material, a proxy config and a new failure mode before an exam-day rehearsal that is already time-boxed. Recorded as the M3 shape; not the sandbox shape. |
| **Bind the edge to the LAN by default and document it** | Documentation is not a control — the same reasoning as ADR-025 and the contract-drift proof. |
| **Network policy in Docker only** | The sandbox runs as host processes; there is no network to place them in. |
| **Bind loopback but publish only via a tunnel** | Operationally heavier for a district venue, and adds a third-party dependency into a rehearsal. |

## 5. Consequences

- A developer's laptop no longer exposes thirteen services to the café network. This changes the *default*, so anything that relied on reaching a service from another host must now set `HTTP_BIND_HOST` — the compose files already do; the sandbox does not.
- The exposure decision is visible in the product surface the owner actually looks at, and is recorded in the log.
- Production gains a fail-fast: a missing `HTTP_BIND_HOST` is a boot error, not a silent black hole. This is a deliberate trade — a container that cannot serve is worse than one that refuses to start loudly.
- `sandbox:full` behaviour is unchanged for every existing journey; only a LAN-reachability test would ever notice.

## 6. Not decided here

- TLS and the reverse-proxy topology (`ADR-040`, S07): the shape the venue will eventually use.
- Whether the venue edge should require client certificates for tablets (device identity exists — `field_devices`, ADR-035/S09 — but binding it to transport is S07/S09).
- Wireless-isolation guidance for the pilot venue (S18 runbook).
