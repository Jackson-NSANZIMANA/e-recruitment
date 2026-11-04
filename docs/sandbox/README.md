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

## What `sandbox:full --status` tells you about the apps

The three apps are built by the frontend's own `pnpm build` (Turbo) and served by each app's own `preview`. Each line names the build being served, Turbo's task hash, and checks it again:

| Line | Meaning |
|---|---|
| `✓ serving build 10c69dfc, current` | the preview this sandbox started serves exactly the build the current sources produce |
| `⚠ serving build …; the sources now build …` | the frontend changed since; `pnpm sandbox:full` rebuilds that app only |
| `⚠ dist/ changed outside the sandbox` | something else rewrote `apps/<app>/dist` (e.g. a direct `pnpm build` in the frontend); the next start rebuilds it |
| `✗ not serving: the last build failed (log)` | the build failed, so nothing is served: the previous bundle is not this source |
| `⚠ answering, but not a server this sandbox started` | another process holds the port; the sandbox will not take it over |

A preview is stopped before its `dist/` is rebuilt and started again only on success, so a page is never served half-written.

## The whole system on your network (HTTPS)

`pnpm sandbox:full` runs everything on this machine and serves the three apps on `http://localhost:4930` (applicant portal), `:4931` (officer console) and `:4932` (Field Station). To open them from a phone, a tablet or another laptop on the same Wi-Fi or LAN:

```bash
pnpm sandbox:full --lan                                   # or SANDBOX_EXPOSE_LAN=1 pnpm sandbox:full
SANDBOX_LAN_ADDRESS=192.168.1.20 pnpm sandbox:full --lan  # when the machine has several addresses
```

The apps are then at `https://<this-machine's-LAN-IP>:4930`, `:4931` and `:4932`. Use those addresses on this machine too: the bundles are built for that origin. A later `pnpm sandbox:full` without `--lan` goes back to `http://localhost` (both builds stay in Turbo's cache, so switching costs seconds).

**What reaches the network.** Exactly three ports, each over TLS (`infrastructure/sandbox/tls-proxy.mjs`). The apps' previews, the edge, the twelve services, Postgres and Kafka stay on `127.0.0.1`. Every API call goes to the app's own origin and through its `/edge` proxy to the edge, so the session cookies keep their production form (`__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`). `--status` shows the three `https://` addresses and an `Exposure` line saying so.

**Trusting the certificate, once per device.** The first `--lan` run makes a sandbox certificate authority in `~/.config/usrp/sandbox-ca` (`SANDBOX_CA_DIR`) and prints its SHA-256 fingerprint. The CA is name-constrained to private addresses (10/8, 172.16/12, 192.168/16, 100.64/10, 127/8) and `localhost`, so a device that trusts it trusts nothing on the internet. On each device, open `http://<LAN-IP>:4930/usrp-sandbox-ca.crt`, check that the fingerprint matches, and install it:

| Device | Install |
|---|---|
| Android | Settings → Security → Encryption & credentials → Install a certificate → CA certificate |
| iPhone / iPad | open the file, Settings → General → VPN & Device Management → install the profile, then Settings → General → About → Certificate Trust Settings → turn it on |
| Windows | double-click → Install Certificate → Local Machine → Trusted Root Certification Authorities |
| macOS | Keychain Access → System → import, then set it to Always Trust |
| Linux (Chrome/Chromium) | `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n usrp-sandbox -i ca.crt` |
| Firefox (any OS) | Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import |

The server certificate in `.sandbox/tls` is reissued automatically when the machine's address changes; devices keep trusting the same CA. Typing `http://` on one of the three ports redirects to `https://`.

**If a device cannot connect**, allow the three ports in this machine's firewall (Ubuntu: `sudo ufw allow 4930:4932/tcp`) and check that both devices are on the same network. Guest and "client isolation" Wi-Fi blocks device-to-device traffic. `--lan` refuses a public address, and refuses `--real-sms` (ADR-053): a network-reachable sandbox with live SMS behind it. Real SMS runs on a local `pnpm sandbox:full --real-sms`.

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
