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
| Android | the link saves `usrp-sandbox-ca.crt` to Downloads; then Settings → search "Install a certificate" → CA certificate → pick it. Use Chrome (some browsers ignore user CAs) |
| iPhone / iPad | open the file, Settings → General → VPN & Device Management → install the profile, then Settings → General → About → Certificate Trust Settings → turn it on |
| Windows | double-click → Install Certificate → Local Machine → Trusted Root Certification Authorities |
| macOS | Keychain Access → System → import, then set it to Always Trust |
| Linux (Chrome/Chromium) | `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n usrp-sandbox -i ca.crt` |
| Firefox (any OS) | Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import |

The server certificate in `.sandbox/tls` is reissued automatically when the machine's address changes; devices keep trusting the same CA. Typing `http://` on one of the three ports redirects to `https://`.

**Verifying from a real device** (the part no automated check here can do):

1. On this machine: `pnpm sandbox:full --lan`; `pnpm sandbox:full --status` shows the three `(LAN)` lines as `✓ https://<ip>:…`. If they are `✗` here, no device will do better.
2. On the device, on the same Wi-Fi: open `http://<ip>:4930/usrp-sandbox-ca.crt`; the SHA-256 fingerprint shown when installing must equal the one `--lan` printed. Install and trust it (table above).
3. Open `https://<ip>:4931`: no certificate warning, the red SANDBOX banner, the officer sign-in. Sign in as `rdf.admin` / `RehearsalAdmin#2026`: the dashboard loads.
4. Open `https://<ip>:4930`: the citizen portal; headings in Atlassian Sans, not the device's system font.
5. A failure that names the certificate (rather than "cannot connect") means the CA is not trusted on that device; "cannot connect" means firewall, a different network, or Wi-Fi client isolation.

**If a device cannot connect**, allow the three ports in this machine's firewall (Ubuntu: `sudo ufw allow 4930:4932/tcp`) and check that both devices are on the same network. Guest and "client isolation" Wi-Fi blocks device-to-device traffic. `--lan` refuses a public address, and refuses `--real-sms` (ADR-053) unless you acknowledge the pair — see below. Real SMS otherwise runs on a local `pnpm sandbox:full --real-sms`.

### Real SMS on the network (`--lan-real-sms`)

To go through the citizen journey from a phone on the venue network *and* receive the OTP on that phone, acknowledge the pair ADR-053 §3.3 refuses by default:

```bash
SANDBOX_LAN_ADDRESS=192.168.1.20 pnpm sandbox:full --lan-real-sms
```

It implies `--lan` and `--real-sms`, and changes two things:

- **only the applicant portal leaves loopback** (`:4930`) by default. The officer console and field station stay on `http://localhost` with their staff credentials, so create campaigns on the laptop, not from the network;
- a yellow banner states what is exposed and that Twilio is live.

Safe because the destination allowlist is built from `TWILIO_TO` and applied *before* the provider is called (`AllowlistSmsChannel`), so nobody else on that network can be texted by this sandbox — they would never receive an OTP. They can still spend `SMS_DAILY_CAP` and ring your number, so do not leave it unattended. The raw-edge form (`SANDBOX_EXPOSE_LAN=1` with `SANDBOX_SMS=twilio`) stays barred in the launcher with no flag that lifts it.

Pair it with your own identity by pointing the overlay at a directory **outside every git work tree**:

```bash
SANDBOX_PRIVATE_PERSONA_DIR=~/path/to/persona SANDBOX_LAN_ADDRESS=192.168.1.20 pnpm sandbox:full --lan-real-sms
```

#### A second machine on the console (`SANDBOX_LAN_APPS`)

For a two-machine rehearsal — the officer console on a second laptop, the portal on a handset — name the apps that should leave loopback:

```bash
SANDBOX_LAN_APPS=applicant-portal,officer-console \
SANDBOX_LAN_ADDRESS=192.168.1.20 pnpm sandbox:full --lan-real-sms
```

Accepts `applicant-portal`, `officer-console`, `field-station` or `all`; an unknown name is refused rather than ignored. It overrides both defaults (all three under plain `--lan`, the portal alone under live SMS).

This puts **officer sign-in on the network**, so a boot wider than one app prints a red warning saying exactly that. Use it on a network you control. At a venue, keep the default and drive the console from the host machine.

Open the extra ports on the host, e.g.:

```bash
sudo ufw allow 4930,4931/tcp
```

`pnpm sandbox:full --status` now prints a `private persona` line — presence only, never values — so a boot that silently fell back to the synthetic population is visible.

## The document door (MinIO, ClamAV, document-forensics)

`pnpm sandbox:full` starts it (`SANDBOX_FORENSICS=1`): its own MinIO on `127.0.0.1:4993` with a freshly minted password, a real ClamAV on `127.0.0.1:4995`, and `document-forensics-service` on `:4904`.

- **MinIO is built from source**, `infrastructure/docker/minio/Dockerfile`: MinIO publishes no community images any more. The build pins `RELEASE.2025-10-15T17-29-55Z` (the final community release, with the service-account sub-policy security fix) and `mc RELEASE.2025-08-13T08-35-41Z` by commit, fetches them through the Go module proxy, verifies them against `sum.golang.org`, and fails if a module does not resolve to its pinned commit. The first boot builds it once (about 3-5 minutes); Docker keeps it after.
- `SANDBOX_MINIO_IMAGE=<image>` uses a mirror instead (pulled, not built). Behind a TLS-intercepting proxy, `SANDBOX_BUILD_EXTRA_CA=/path/to/ca.crt` gives the build that proxy's CA as a build secret (never an image layer).
- ClamAV keeps its signatures in the volume `usrp-tier2_clamav-data`, shared with tier2; the launcher creates it when missing and Docker seeds it from the image's bundled database.
- Proof against the sandbox's own door (EICAR refused by the real ClamAV, clean and stripped JPEGs classified, idempotent re-analysis, fail-closed when the scanner is down), with tier1 Postgres bootstrapped (`pnpm bootstrap:db`):

```bash
MINIO_ENDPOINT=127.0.0.1 MINIO_PORT=4993 MINIO_ROOT_USER=usrp_sandbox_minio \
MINIO_ROOT_PASSWORD="$(node -p "require('./.sandbox/secrets.json').MINIO_ROOT_PASSWORD")" \
CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=4995 DATABASE_URL=postgresql://usrp_app:app_pw@localhost:5432/usrp_db \
pnpm --filter @usrp/document-forensics-service exec tsx selfcheck/verify-forensics-slice.ts
```

## The sandbox broker's memory

The sandbox Kafka (`:4992`) runs a 384 MiB heap in a 768 MiB container. Measured under the six journeys it settles at about 545 MiB, peaking at 605 MiB including page cache, so the earlier 512 MiB limit was below the broker's own working set. Its healthcheck is a second JVM in the same container; it now runs with its own 48 MiB heap instead of inheriting the broker's `KAFKA_HEAP_OPTS`, which made every probe start with `-Xmx384M -Xms192M` and got the broker OOM-killed (exit 137) within minutes of a boot. `scripts/test/infra-budgets.test.mjs` keeps both rules for the sandbox and tier2 brokers.

## Starting from an empty database (only the administrators)

```bash
pnpm sandbox:full --down
SANDBOX_DB=usrp_sandbox_eval pnpm sandbox:clean          # dry run: what would go
SANDBOX_DB=usrp_sandbox_eval pnpm sandbox:clean --yes    # do it (a pg_dump backup is written first)
SANDBOX_DB=usrp_sandbox_eval pnpm sandbox:full --no-staging --lan
```

`sandbox:clean` keeps the agency administrators (the `agency_admin` role), the platform service account and the schema, and removes everything else: rehearsal staff, citizens, campaigns, applications, documents, sessions, events, the audit log, the sandbox broker's and object store's volumes, and the personas, SMS inbox and logs on disk. It only accepts `usrp_sandbox*` databases, refuses while the sandbox runs, and changes the database in one transaction. The evidence tables are append-only by law (N° 058/2021); their 27 `TRUNCATE` guards are disabled only inside that transaction and verified enabled afterwards. `--no-staging` boots without the six campaigns, rehearsal staff and personas, so the database stays as you leave it; create campaigns in the officer console. Restore with the `pg_restore` command the tool prints.

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
