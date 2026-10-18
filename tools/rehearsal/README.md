# USRP Rehearsal

Stage a complete, synthetic recruitment cycle on the **real** platform, for
development, staff training and pilot drills. Design and guarantees:
[ADR-035](../../docs/architecture/adrs/ADR-035-rehearsal.md).

```bash
pnpm infra:up && pnpm dev        # the platform (dev SMS inbox on by default)
pnpm rehearse                    # stage national-pilot-day for today (Kigali)
pnpm rehearse --status           # list open rehearsal campaigns
pnpm dev:sms                     # read the one-time codes personas receive
```

What `pnpm rehearse` does, in order, per agency, through the real interfaces only:

1. provision the agency administrator (`<agency>.admin`, dev password `RehearsalAdmin#2026`)
   through the first-admin function; an agency that already has a different
   administrator is never given a second one (set `REHEARSAL_<AGENCY>_ADMIN_HANDLE`
   and `REHEARSAL_<AGENCY>_ADMIN_PASSWORD` instead);
2. sign in at the edge as that administrator;
3. **staff** the day (ADR-036): create each scenario officer (`reh.<agency>.…`)
   through `createOfficer`, redeem its one-time code through `activateOfficer`
   with the dev password `RehearsalStaff#2026`, and align its posts through
   `assignOfficerPosts` (recovering an earlier run with `enableOfficer` /
   `reissueOfficerActivation`); then fail unless `listOfficers` shows each one
   active with exactly its posts. The dev seeder is not used for this;
4. close earlier days' rehearsal campaigns (never delete);
5. draft → policy version → one session per district → publish, each with a
   deterministic `Idempotency-Key`;
6. confirm the public detail serves the campaign.

Everything it creates is marked as a rehearsal: `REH-<AGENCY>-<YYYYMMDD>` codes,
`[REHEARSAL]` labels, "Rehearsal Venue — …" venues, legal basis
`SYNTHETIC-REHEARSAL`. It refuses `NODE_ENV=production` and any non-local
database or edge.

| Variable | Default |
|---|---|
| `REHEARSAL_EDGE_URL` | `http://localhost:$PORT_EDGE_GATEWAY` (4021) |
| `REHEARSAL_ORIGIN` | `http://localhost:3001` (the officer console origin, for CSRF origin pinning) |
| `REHEARSAL_DATABASE_URL` | `DEV_SEED_DATABASE_URL`, else the same local default as `scripts/bootstrap-db.sh` |

The live journey that rehearses the personas end to end lives in the frontend
repo: `USRP_LIVE=1 npx playwright test e2e/live-rehearsal.spec.ts` in
`apps/applicant-portal`.

Add a scenario by writing `scenarios/<id>.json` (validated before any call)
and running `pnpm rehearse <id>`.
