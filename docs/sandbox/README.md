# The USRP sandbox guide

The sandbox runs the whole recruitment life cycle on simulated registries that behave like the live ones (ADR-047), with the six real campaigns published from **campaign policy v2** (ADR-049). Everything in it is synthetic. A campaign here is never a Government of Rwanda recruitment.

## One command

```bash
pnpm sandbox:up      # boot + stage the six campaigns; safe to run again
pnpm sandbox:down    # stop; keeps data
pnpm sandbox:reset   # stop and drop the sandbox database and state ONLY (never the dev stack's)
```

- It uses its own database (`SANDBOX_DB`, default `usrp_sandbox`), its own Kafka (compose project `usrp-sandbox`) and ports 4900-4921. On a shared machine pick your own: `SANDBOX_DB=usrp_sandbox_me pnpm sandbox:up`, and check `pnpm sandbox --status` first. Never stop a sandbox you did not start.
- `sandbox:up` reuses a sandbox that already answers on :4921, and staging is idempotent.
- Logs and secrets: `.sandbox/` (git-ignored, mode 0700).

**What `sandbox:up` is not yet.** The sandbox services run as detached processes in production mode (`NODE_ENV=production`, `USRP_ENVIRONMENT=sandbox`, freshly minted secrets), not as container images behind a local TLS edge. Compose images, the three SPA-serving images and a Caddy internal-CA edge (ports 51xx) are the remaining part of S12c kit item C; see the PR hand-off.

## The six campaigns

Facts come only from `docs/product/recruitment-announcements-2025-2026.md` (never the English translations).

| Scenario | Campaign | Notes |
|---|---|---|
| `rdf-2026` | RDF regular personnel and Reserve | S3 minimum; caps 25 / 26 / 27 by qualification; walk-in **on** |
| `rnp-basic-2025` | RNP Basic Police Course | never sentenced to 6 months **or more** |
| `rnp-cadet-2025` | RNP Cadet | never sentenced to **more than** 6 months |
| `rcs-junior-2025` | RCS junior staff | not under prosecution; notarised certificate |
| `rcs-officer-2026-1y` | RCS officer, one-year track | A0 **or** A1 IPRC; specialists up to 27; walk-in **off** (default, owner to confirm) |
| `rcs-officer-2026-4y` | RCS officer, four-year track | 18-21; at least 70% in science |

`pnpm rehearse --sandbox <scenario>` stages one; `pnpm rehearse --sandbox <scenario> --journey` plays its personas through the real edge.

## Staff and sign-in

Each scenario provisions its station staff through the officer lifecycle (handles start with `reh.`, e.g. `reh.rdf.gate.nyagatare`, `reh.rdf.reviewer`, `reh.rdf.supervisor`); `pnpm rehearse` prints them with the shared rehearsal password and the agency administrator handles. Citizens sign in by SMS: the code is in the **SMS emulator inbox**, `.sandbox/sms/inbox.jsonl` (no real SMS is ever sent unless the owner opts in locally, see `tools/g2g-sandbox`).

## Personas

Catalogue ids look like `A-RDF-PILOT-S3-ELIGIBLE`, `A-RDF-PILOT-OVER-AGE-1D`, `A-RDF-PILOT-NESA-MISMATCH`, `P-UR-SCI-69`, `P-CLEARANCE-VALID`. Each scenario file lists its personas with what each rehearses and the expected outcome. Ages are relative to today.

The owner's own record may join **locally only** through `SANDBOX_PRIVATE_PERSONA_DIR`; it is never committed and its values are never printed (pass or fail only).

## Behaviour switches

A registry can be made to misbehave without a negative verdict ever being issued: `slow`, `rate-limited` (429 with Retry-After), `maintenance`, `timeout`, `truncated`, `status-false`. Per persona (as the catalogue defines) or per request with the header `x-usrp-sandbox-behaviour` on the simulator (:4900). A registry outage leaves the citizen at "we are verifying", never "rejected".

## What a citizen sees

Applying pre-fills identity from the platform's verified NIDA record (`getMyIdentity`): names, sex, date of birth, district. Photo, signature, parents' names and the National ID are never returned. Health questions are never asked in the portal; they belong to the medical station.
