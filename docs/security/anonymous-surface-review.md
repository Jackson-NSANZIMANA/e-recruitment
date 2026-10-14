# Review dossier — anonymous (unauthenticated) browser surface

The allowlist in `e-recruitment-ui/packages/contracts/scripts/lint/route-invariants.ts`
grew from 4 to 7 entries. A reviewer must sign each addition.

| Operation | Edge path | What a stranger can learn | Controls | Residual risk |
|---|---|---|---|---|
| `beginApplicantOnboarding` | `POST /edge/v1/auth/applicant/identity` | Only "details matched NIDA" or one uniform 422 | NID shape; DOB must be a real date; per-NID bucket (5/min) + per-client bucket; **durable lockout** (5 mismatches/1 h, keyed by NID HMAC, skips NIDA while locked even for the right DOB); unknown NIDs never counted; CSRF; fail-closed limiter | A person who knows a NID can lock that citizen out for 1 h (DoS). NIDA call volume from bots needs CAPTCHA/WAF in front |
| `listPublicCampaigns` | `GET /edge/v1/campaigns` | Open campaigns: label, public code, dates, categories, districts, contacts | Server-side allowlist (13 fields); no internal ids/policy/capacity/counts; 502 on shape drift | Scraping of intended-public data |
| `getPublicCampaign` | `GET /edge/v1/campaigns/detail?publicCode=` | Same projection for one code | Exactly one `publicCode`; shape check; 404 for unpublished | Enumeration reveals only published campaigns |
| `requestApplicantOtp` (existing) | `POST .../otp/request` | Nothing: uniform 202 | token-bound; per-token/per-phone/per-client limits; MTN/Airtel only | SMS-cost abuse until a provider-side cap exists |
| `verifyApplicantOtp` (existing) | `POST .../otp/verify` | Nothing: one 401 | single-use CAS, 5-attempt lock, code bound to the phone | — |

## Checks the reviewer can run
- `pnpm --filter @usrp/edge-gateway selfcheck:security` (byte-identical non-match bodies).
- `services/identity-service/selfcheck/verify-applicant-auth-slice.ts` §9 (live lockout).
- `e-recruitment-ui/packages/contracts` `pnpm test` (the allowlist rule that forces this review).

## Needed before production
CAPTCHA / proof-of-work or WAF shaping in front of `/identity`; an SMS cost cap
with the chosen provider; monitoring on `EDGE_RATE_LIMITED` and lockout counts.
