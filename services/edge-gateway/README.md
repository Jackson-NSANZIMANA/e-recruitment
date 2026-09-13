# `@usrp/edge-gateway`

The **only** browser-reachable origin in USRP (ADR-021). One edge for all three
agencies and for citizens — not four per-agency BFFs.

- **The browser holds an opaque handle**, never a credential. The officer
  Ed25519 JWT and the citizen opaque token stay server-side, encrypted at rest.
- **Agency is never a request field.** It comes from the signed token claims,
  which is what makes it server-authoritative by construction.
- **Exact paths, no parameters** (ADR-005). Single-record reads use
  `?applicationId=`.
- **No `Authorization` header on any operation.** There is no security scheme
  that would permit one.

```bash
PORT_EDGE_GATEWAY=4021 pnpm --filter @usrp/edge-gateway start:dev
pnpm --filter @usrp/edge-gateway selfcheck     # needs tier1 + rls/0019
```

Read next: [ADR-021](../../docs/architecture/adr/ADR-021-edge-tier.md) ·
[slice doc](../../docs/architecture/edge-gateway-slice.md) ·
[contract deviations](./docs/CONTRACT-DEVIATIONS.md).

Required environment beyond the platform defaults: `IDENTITY_SERVICE_BASE_URL`,
`IAM_BASE_URL`, `APPLICATION_SERVICE_BASE_URL`, `EDGE_SESSION_HMAC_KEY`,
`EDGE_COOKIE_SECURE` (**must** be `true` in production — `__Host-` requires it),
`CORS_ORIGINS`, `AUTH_JWT_PUBLIC_KEY_B64`.
