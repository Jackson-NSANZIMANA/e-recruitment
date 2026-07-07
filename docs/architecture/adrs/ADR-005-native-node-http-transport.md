# ADR-005 — Native-Node HTTP transport over a framework (NestJS)

- **Status:** Accepted (2026-07-07)
- **Deciders:** Principal engineer, on behalf of the owner (subject to veto)
- **Supersedes/relates:** Resolves the transport question deferred by the
  identity-service first slice (`docs/architecture/identity-service-slice.md`).

## Context

The service cores are **hexagonal**: framework-agnostic domain + ports, with a
composition root that wires adapters by hand (see `identity-service`). After the
first slice, every service is still a *library* — there is no process that
listens on a socket, so nothing can be called, deployed, or integration-tested
over the wire. Choosing the ingress transport is the true critical path: it is
the single most-shared unmade decision, inherited by all 11 services.

The repository handbook named NestJS as the "intended" framework. This ADR
revisits that against the project's own most load-bearing principle.

### Forces

1. **Minimal supply-chain surface is the crown-jewel principle.** The shared
   packages are deliberately zero-runtime-dependency (Node built-ins only); the
   predecessor chose minimalist deps (postgres.js, drizzle, kafkajs). For a
   system holding citizen PII, biometrics metadata, and criminal-record status
   under Law N° 058/2021, every transitive dependency at the **public ingress**
   — the most exposed layer — is attack surface and audit burden.
2. **The core is already hexagonal.** Dependency injection is done explicitly in
   the composition root. A framework DI container (NestJS + reflect-metadata +
   rxjs + decorator tree) would be redundant weight, not leverage.
3. **The platform is thin at the edge.** A service's ingress needs: routing,
   bounded JSON parsing, a uniform error shape, health/readiness, correlation-id
   propagation, structured access logging, and graceful shutdown. All of these
   are a few hundred lines over `node:http`. Node 24 ships the HTTP server and
   `fetch` natively.
4. **Transport is an adapter.** In hexagonal terms the choice sits at the very
   edge and touches no business logic — which makes it **reversible at the
   adapter layer**.

## Decision

Adopt a **zero-dependency `@usrp/shared-http` substrate built on `node:http`** as
the standard service ingress. Each service exposes routes through a thin HTTP
adapter that translates requests into use-case commands and use-case outcomes
into HTTP results; the domain stays transport-agnostic.

`@usrp/shared-http` provides exactly, and only:

- typed exact-match routing (`method` + `path` → handler);
- bounded JSON body parsing (default 64 KiB cap → `413`; wrong content-type →
  `415`; malformed → `400`);
- a uniform `problem`-style error shape via a single `HttpError`, with 5xx
  details never exposed to the client;
- `GET /health` (liveness) and `GET /ready` (readiness probe supplied by the
  service — e.g. DB reachable, bus connected);
- correlation-id propagation (`x-correlation-id` in/out; a fresh id per request
  in `x-request-id`) so an inbound HTTP request seeds the Kafka event trace;
- one structured JSON access-log line per request (never bodies, never PII);
- graceful shutdown (SIGTERM/SIGINT → stop accepting, drain in-flight, run a
  service `onShutdown`, force-close after a timeout).

## Consequences

**Positive**
- Zero new runtime dependencies at the most exposed layer; every line is ours to
  audit. Consistent with the shared-package ethos.
- No hidden framework magic: routing and lifecycle are explicit and testable.
- The transport is proven the same way everything else here is — a live
  self-check that drives a real socket (`identity-service` HTTP slice).

**Negative / accepted trade-offs**
- We forgo NestJS conveniences: validation pipes, guards/interceptors,
  first-party OpenAPI generation, modules, and a larger hiring pool of engineers
  who know the framework. Input validation and (later) OpenAPI are done
  explicitly per adapter instead. This is a real cost, accepted in favour of the
  supply-chain principle.
- Advanced needs (HTTP/2, content negotiation, multipart uploads for the
  document-forensics service) are **not** built now. They are added deliberately
  when a slice needs them — as a scoped extension of this substrate or a
  localized dependency in that one service, not a platform-wide framework.

**Reversibility.** Because ingress is a hexagonal adapter, adopting NestJS (or
Fastify, etc.) later is a new adapter + composition root for a given service, not
a rewrite of any domain or application code. This ADR can be revisited per
service without churning the core.

## Alternatives considered

- **NestJS** — conventional, batteries-included, but contradicts the crown-jewel
  minimal-dependency principle at the worst possible layer and duplicates the
  hand-rolled hexagonal DI. Rejected as the default; still reachable per-service
  under reversibility.
- **Fastify / Express** — lighter than Nest but still a dependency tree and
  plugin surface for capabilities we do not yet need. Rejected for now.
- **Do nothing (keep services as libraries)** — leaves the platform unrunnable;
  not viable.
