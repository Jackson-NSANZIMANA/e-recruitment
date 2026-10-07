# USRP Web — Recruitment Operations Console

This frontend is integrated into the backend monorepo as `services/web` and follows the approved Atlassian-style mockup.

## Design contract

- Secure officer operations console for **RDF, RNP and RCS**.
- Atlassian-inspired dense navigation, neutral surfaces, lozenges, tables, cards, drawers and operational hierarchy.
- Real RDF imagery from Rwanda Ministry of Defence is used in the hero/login surface.
- Officer agency is taken from `GET /edge/v1/session`; the browser never offers an agency switch.
- The browser talks only to the Edge Gateway.

## Current wired operations

- `GET /edge/v1/session`
- `POST /edge/v1/auth/officer/login`
- `POST /edge/v1/auth/officer/logout`
- `GET /edge/v1/applications`
- `GET /edge/v1/applications/amber-queue`
- `GET /edge/v1/applications/detail?applicationId=...`
- `POST /edge/v1/applications/medical-review`
- `POST /edge/v1/applications/accept`

Medical review follows the backend's real agency contract: RDF uses `FIT|UNFIT`; RNP/RCS use `CERT_VERIFIED|CERT_REJECTED`.

Pages whose current backend contract exposes operations without a corresponding browser read model are intentionally marked as reserved rather than populated with invented data.

## Local development

```bash
cd services/web
pnpm dev
```

The browser expects the Edge Gateway at the same origin under `/edge`. In local development, put the frontend behind a proxy/reverse proxy to the Edge Gateway, or serve it from the same origin.