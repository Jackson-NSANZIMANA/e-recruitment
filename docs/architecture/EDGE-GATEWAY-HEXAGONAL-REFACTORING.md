# Edge Gateway Hexagonal Architecture Refactoring Plan

**Date**: 2024-09-22  
**Author**: Senior Software Systems Architect  
**Status**: Architecture Analysis & Refactoring Proposal  
**Target Service**: `services/edge-gateway`

---

## Executive Summary

The edge-gateway service currently deviates from the hexagonal architecture pattern consistently applied across all other microservices in the e-recruitment system. This document provides a comprehensive analysis and refactoring plan to align the edge-gateway with the established architectural standards.

**Current State**: Feature-based flat structure  
**Target State**: Hexagonal architecture with domain/application/ports/adapters layers  
**Estimated Effort**: 3-5 days (senior engineer)  
**Risk Level**: Medium (requires careful migration of session management and security logic)

---

## 1. Architectural Inconsistency Analysis

### 1.1 Standard Hexagonal Architecture (Other Services)

All microservices (`identity-service`, `iam-service`, `application-service`, etc.) follow this structure:

```
services/{service-name}/src/
├── domain/           # Domain entities, errors, types
├── application/      # Use cases/application services
├── ports/            # Interfaces for external dependencies
├── adapters/         # Implementations of ports
│   ├── http/         # HTTP controllers
│   ├── events/       # Event consumers/publishers
│   └── *.pg-repository.ts  # Database adapters
├── config.ts
├── index.ts          # Composition root
└── main.ts           # Runtime entry point
```

**Key Characteristics**:
- **Domain Layer**: Business logic, domain entities, domain errors
- **Application Layer**: Use case orchestration (e.g., `verify-identity.service.ts`)
- **Ports Layer**: Abstract interfaces defining contracts (`*.repository.ts`, `*.gateway.ts`)
- **Adapters Layer**: Concrete implementations of ports
- **Dependency Direction**: Inward (adapters → ports → application → domain)

### 1.2 Current Edge Gateway Structure (Non-Conformant)

```
services/edge-gateway/src/
├── adapters/http/    # HTTP controllers only
├── observability/    # Audit logging
├── registry/         # Edge and upstream operations
├── security/         # Rate limiting, CSRF, cookies, credential cipher
├── session/          # Session management
├── upstream/         # Upstream client
├── config.ts
├── index.ts
├── main.ts
└── routes.ts
```

**Issues Identified**:
1. **Missing domain layer** - No domain entities or business logic separation
2. **Missing application layer** - No use case services; logic embedded in controllers
3. **Missing ports layer** - No abstraction for external dependencies
4. **Feature-based organization** - Organized by technical concern, not hexagonal layers
5. **Tight coupling** - Controllers directly depend on concrete implementations
6. **Inconsistent with platform standards** - Only service not following hexagonal architecture

---

## 2. Detailed Gap Analysis

### 2.1 What's Missing

| Layer | Expected | Current State | Gap |
|-------|----------|---------------|-----|
| **Domain** | Domain entities, business rules, domain errors | None | Complete layer missing |
| **Application** | Use case services (session management, auth orchestration) | Logic scattered in controllers | Need to extract and centralize |
| **Ports** | Session repository interface, upstream gateway interface, rate limiter interface | Concrete implementations only | Need to define abstractions |
| **Adapters** | Only HTTP | Only HTTP (correct) | Missing event adapters if needed |

### 2.2 What Exists But Needs Reorganization

| Current Location | Content | Target Location |
|------------------|---------|-----------------|
| `session/session-store.pg.ts` | PostgreSQL session store | `adapters/session-store.pg-repository.ts` |
| `session/session.types.ts` | Session types | Split: domain types → `domain/`, port interface → `ports/` |
| `upstream/upstream-client.ts` | Upstream HTTP client | `adapters/upstream.http-gateway.ts` |
| `security/rate-limiter.ts` | Rate limiting implementation | Split: interface → `ports/`, impl → `adapters/` |
| `security/credential-cipher.ts` | Credential encryption | `adapters/credential-cipher.ts` (or domain service) |
| `security/csrf.ts` | CSRF validation | Keep in security utilities or move to `adapters/http/middleware/` |
| `security/cookies.ts` | Cookie management | Keep in security utilities or move to `adapters/http/middleware/` |
| `observability/audit-log.ts` | Audit logging | `adapters/audit-logger.ts` (with port interface) |
| `registry/edge-operations.ts` | Edge operation registry | `domain/edge-operations.ts` (domain vocabulary) |
| `registry/upstream-operations.ts` | Upstream operation registry | `domain/upstream-operations.ts` |
| `adapters/http/*.controller.ts` | HTTP handlers | Refactor to thin controllers calling application services |

---

## 3. Proposed Hexagonal Architecture

### 3.1 Target Directory Structure

```
services/edge-gateway/src/
├── domain/
│   ├── edge-operations.ts          # Edge operation registry (domain vocabulary)
│   ├── upstream-operations.ts      # Upstream operation registry
│   ├── session.types.ts            # Session domain entities
│   ├── edge.errors.ts              # Domain-specific errors
│   └── rate-limit.types.ts         # Rate limiting domain types
│
├── application/
│   ├── session-management.service.ts     # Session lifecycle use case
│   ├── officer-auth.service.ts           # Officer authentication use case
│   ├── applicant-auth.service.ts         # Applicant authentication use case
│   ├── upstream-proxy.service.ts         # Upstream request proxying use case
│   ├── walk-in-registration.service.ts   # Walk-in registration orchestration
│   ├── identity-verification.service.ts  # Identity verification orchestration
│   └── field-sync.service.ts             # Field sync orchestration
│
├── ports/
│   ├── session-repository.ts       # Session persistence interface
│   ├── upstream-gateway.ts         # Upstream communication interface
│   ├── rate-limiter.ts             # Rate limiting interface
│   ├── credential-cipher.ts        # Credential encryption interface
│   └── audit-logger.ts             # Audit logging interface
│
├── adapters/
│   ├── http/
│   │   ├── session.controller.ts
│   │   ├── officer-auth.controller.ts
│   │   ├── applicant-auth.controller.ts
│   │   ├── officer-reads.controller.ts
│   │   ├── officer-transitions.controller.ts
│   │   ├── identity.controller.ts
│   │   ├── citizen.controller.ts
│   │   ├── walk-in.controller.ts
│   │   ├── field-sync.controller.ts
│   │   ├── guards.ts               # Auth guards
│   │   ├── validation.ts           # Input validation
│   │   ├── outcomes.ts             # HTTP outcome mapping
│   │   ├── projections.ts          # Response projections
│   │   └── middleware/
│   │       ├── csrf.ts
│   │       └── leak-guard.ts
│   │
│   ├── session-store.pg-repository.ts     # PostgreSQL session store
│   ├── upstream.http-gateway.ts           # Upstream HTTP client
│   ├── fixed-window-rate-limiter.ts       # In-memory rate limiter
│   ├── credential-cipher.adapter.ts       # Credential encryption impl
│   └── audit-logger.adapter.ts            # Audit logging impl
│
├── config.ts
├── index.ts          # Composition root
├── main.ts           # Runtime entry point
└── routes.ts         # Route composition
```

### 3.2 Layer Responsibilities

#### Domain Layer
- **Edge operations registry**: The contract vocabulary (paths, methods, session requirements)
- **Session types**: SessionKind, SessionView, EdgeSession domain entities
- **Domain errors**: AuthenticationError, SessionExpiredError, RateLimitExceededError
- **Business rules**: Session TTL logic, rate limiting rules

#### Application Layer
- **Session management**: Create, refresh, revoke, read sessions
- **Auth orchestration**: Officer login/logout, applicant OTP flows
- **Upstream proxying**: Coordinate upstream calls with session resolution
- **Use case orchestration**: Walk-in registration, identity verification flows

#### Ports Layer
- **Interfaces only**: No implementations, pure TypeScript interfaces
- **Dependency inversion**: Application depends on ports, adapters implement ports

#### Adapters Layer
- **HTTP controllers**: Thin adapters translating HTTP ↔ application services
- **Repositories**: PostgreSQL session store
- **Gateways**: Upstream HTTP client
- **Infrastructure**: Rate limiter, cipher, audit logger

---

## 4. Refactoring Strategy

### 4.1 Phased Migration Plan

#### Phase 1: Create Hexagonal Structure (Non-Breaking)
**Duration**: 1 day  
**Risk**: Low

1. Create new directory structure (domain/, application/, ports/, adapters/)
2. Create port interfaces (no implementations yet)
3. Create domain types and errors
4. Keep existing code in place (parallel structure)

**Deliverables**:
- Empty hexagonal directory structure
- Port interfaces defined
- Domain types extracted
- No functional changes

#### Phase 2: Extract Application Services
**Duration**: 2 days  
**Risk**: Medium

1. Create `SessionManagementService` wrapping current session logic
2. Create `OfficerAuthService` wrapping officer auth logic
3. Create `ApplicantAuthService` wrapping applicant auth logic
4. Create `UpstreamProxyService` wrapping upstream client logic
5. Refactor controllers to delegate to application services

**Deliverables**:
- Application service implementations
- Controllers refactored to thin adapters
- Unit tests for application services

#### Phase 3: Implement Adapters
**Duration**: 1 day  
**Risk**: Low

1. Move `PgEdgeSessionStore` to `adapters/session-store.pg-repository.ts`
2. Move `UpstreamClient` to `adapters/upstream.http-gateway.ts`
3. Move `FixedWindowRateLimiter` to `adapters/fixed-window-rate-limiter.ts`
4. Update composition root (`index.ts`) to wire dependencies

**Deliverables**:
- All adapters implementing port interfaces
- Dependency injection through composition root
- Integration tests passing

#### Phase 4: Cleanup & Documentation
**Duration**: 0.5 days  
**Risk**: Low

1. Remove old directory structure
2. Update imports across codebase
3. Update documentation
4. Verify selfchecks pass

**Deliverables**:
- Clean hexagonal structure
- Updated documentation
- All tests passing
- Selfchecks passing

### 4.2 Migration Safety

**Non-Breaking Approach**:
- Keep existing functionality unchanged
- Refactor internal structure only
- No API contract changes
- All existing tests must pass

**Rollback Strategy**:
- Git feature branch for entire refactoring
- Each phase is a separate commit
- Can cherry-pick phases if needed
- Original structure preserved until final cleanup

---

## 5. Detailed Implementation Plan

### 5.1 Domain Layer Implementation

#### File: `domain/session.types.ts`
```typescript
// Domain entities for session management
export type SessionKind = 'officer' | 'applicant';

export interface EdgeSession {
  readonly sessionId: string;
  readonly kind: SessionKind;
  readonly subjectId: string | null;
  readonly agency: string | null;
  readonly roles: readonly string[] | null;
  readonly upstreamCredential: string | null;
  readonly upstreamExpiresAt: string | null;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revoked: boolean;
  readonly revokedReason: string | null;
}

export interface SessionView {
  readonly kind: SessionKind;
  readonly subjectId: string | null;
  readonly agency: string | null;
  readonly roles: readonly string[] | null;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
}
```

#### File: `domain/edge.errors.ts`
```typescript
// Domain-specific errors
export class SessionNotFoundError extends Error {
  constructor(message = 'Session not found') {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionExpiredError extends Error {
  constructor(message = 'Session has expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export class SessionRevokedError extends Error {
  constructor(message = 'Session has been revoked') {
    super(message);
    this.name = 'SessionRevokedError';
  }
}

export class RateLimitExceededError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Rate limit exceeded'
  ) {
    super(message);
    this.name = 'RateLimitExceededError';
  }
}

export class AuthenticationFailedError extends Error {
  constructor(message = 'Authentication failed') {
    super(message);
    this.name = 'AuthenticationFailedError';
  }
}

export class UpstreamUnavailableError extends Error {
  constructor(
    public readonly code: string,
    public readonly upstreamOperationId: string,
    cause?: unknown
  ) {
    super(`Upstream ${upstreamOperationId} unavailable (${code})`, { cause });
    this.name = 'UpstreamUnavailableError';
  }
}
```

### 5.2 Ports Layer Implementation

#### File: `ports/session-repository.ts`
```typescript
import type { SessionKind, EdgeSession } from '../domain/session.types.js';

export interface CreateSessionInput {
  readonly kind: SessionKind;
  readonly subjectId: string | null;
  readonly agency: string | null;
  readonly roles: readonly string[] | null;
  readonly upstreamCredential: string | null;
  readonly upstreamExpiresAt: string | null;
}

export interface CreateSessionResult {
  readonly session: EdgeSession;
  readonly handle: string;
  readonly csrfToken: string;
}

export interface SessionStats {
  readonly activeOfficer: number;
  readonly activeApplicant: number;
  readonly revoked: number;
  readonly expired: number;
}

export interface SessionRepository {
  create(input: CreateSessionInput, now: Date): Promise<CreateSessionResult>;
  findByHandle(handleHash: string, now: Date): Promise<EdgeSession | null>;
  touch(sessionId: string, now: Date): Promise<void>;
  revoke(sessionId: string, reason: string, now: Date): Promise<void>;
  deleteExpired(before: Date): Promise<number>;
  stats(now: Date): Promise<SessionStats>;
}
```

#### File: `ports/upstream-gateway.ts`
```typescript
import type { UpstreamOperation } from '../domain/upstream-operations.js';

export interface UpstreamCallInput {
  readonly operation: UpstreamOperation;
  readonly correlationId: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly credential?: string;
}

export interface UpstreamResult {
  readonly status: number;
  readonly body: unknown;
}

export interface UpstreamGateway {
  call(input: UpstreamCallInput): Promise<UpstreamResult>;
}
```

#### File: `ports/rate-limiter.ts`
```typescript
export interface RateLimitCheck {
  readonly allowed: boolean;
  readonly remainingTokens: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  check(bucketKey: string, limit: number): RateLimitCheck;
  size(): number;
}
```

### 5.3 Application Layer Implementation

#### File: `application/session-management.service.ts`
```typescript
import type { SessionRepository } from '../ports/session-repository.js';
import type { CredentialCipher } from '../ports/credential-cipher.js';
import type { AuditLogger } from '../ports/audit-logger.js';
import type { EdgeSession, SessionView } from '../domain/session.types.js';
import { SessionNotFoundError, SessionExpiredError, SessionRevokedError } from '../domain/edge.errors.js';

export interface SessionManagementDeps {
  readonly repository: SessionRepository;
  readonly cipher: CredentialCipher;
  readonly audit: AuditLogger;
}

export class SessionManagementService {
  constructor(private readonly deps: SessionManagementDeps) {}

  async readSession(handle: string, now: Date): Promise<SessionView | null> {
    const handleHash = this.deps.cipher.hashHandle(handle);
    const session = await this.deps.repository.findByHandle(handleHash, now);
    
    if (session === null) return null;
    if (session.revoked) throw new SessionRevokedError();
    if (session.expiresAt < now || session.absoluteExpiresAt < now) {
      throw new SessionExpiredError();
    }

    return this.toView(session);
  }

  async refreshSession(
    handle: string,
    csrfToken: string,
    now: Date
  ): Promise<{ session: SessionView; newCsrfToken: string }> {
    const handleHash = this.deps.cipher.hashHandle(handle);
    const session = await this.deps.repository.findByHandle(handleHash, now);
    
    if (session === null) throw new SessionNotFoundError();
    if (session.revoked) throw new SessionRevokedError();
    
    // Validate CSRF token
    const expectedCsrf = this.deps.cipher.generateCsrfToken(session.sessionId);
    if (csrfToken !== expectedCsrf) {
      throw new Error('CSRF token mismatch');
    }

    await this.deps.repository.touch(session.sessionId, now);
    
    const newCsrfToken = this.deps.cipher.generateCsrfToken(session.sessionId);
    
    return {
      session: this.toView(session),
      newCsrfToken,
    };
  }

  async revokeSession(sessionId: string, reason: string, now: Date): Promise<void> {
    await this.deps.repository.revoke(sessionId, reason, now);
    
    this.deps.audit.log({
      action: 'EDGE_SESSION_DESTROYED',
      sessionId,
      reason,
      timestamp: now,
    });
  }

  private toView(session: EdgeSession): SessionView {
    return {
      kind: session.kind,
      subjectId: session.subjectId,
      agency: session.agency,
      roles: session.roles,
      expiresAt: session.expiresAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
    };
  }
}
```

#### File: `application/officer-auth.service.ts`
```typescript
import { verifyAuthToken } from '@usrp/shared-auth';
import type { SessionRepository } from '../ports/session-repository.js';
import type { UpstreamGateway } from '../ports/upstream-gateway.js';
import type { RateLimiter } from '../ports/rate-limiter.ts';
import type { AuditLogger } from '../ports/audit-logger.js';
import { UPSTREAM } from '../domain/upstream-operations.js';
import { AuthenticationFailedError, RateLimitExceededError } from '../domain/edge.errors.js';

export interface OfficerLoginCommand {
  readonly loginHandle: string;
  readonly password: string;
  readonly correlationId: string;
  readonly clientKey: string;
}

export interface OfficerLoginResult {
  readonly handle: string;
  readonly csrfToken: string;
}

export interface OfficerAuthConfig {
  readonly authPublicKeyPem: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly handleHmacKey: string;
  readonly loginRateLimit: number;
}

export interface OfficerAuthDeps {
  readonly sessions: SessionRepository;
  readonly upstream: UpstreamGateway;
  readonly limiter: RateLimiter;
  readonly audit: AuditLogger;
  readonly config: OfficerAuthConfig;
}

export class OfficerAuthService {
  constructor(private readonly deps: OfficerAuthDeps) {}

  async login(command: OfficerLoginCommand, now: Date): Promise<OfficerLoginResult> {
    // Rate limiting
    const targetLimit = this.deps.limiter.check(
      this.targetBucketKey(command.loginHandle),
      this.deps.config.loginRateLimit
    );
    if (!targetLimit.allowed) {
      throw new RateLimitExceededError(targetLimit.retryAfterSeconds);
    }

    const clientLimit = this.deps.limiter.check(
      `${command.clientKey}:officerLogin`,
      this.deps.config.loginRateLimit
    );
    if (!clientLimit.allowed) {
      throw new RateLimitExceededError(clientLimit.retryAfterSeconds);
    }

    // Call upstream IAM
    const upstream = await this.deps.upstream.call({
      operation: UPSTREAM.officerLogin,
      correlationId: command.correlationId,
      body: { loginHandle: command.loginHandle, password: command.password },
    });

    if (upstream.status !== 200) {
      throw new AuthenticationFailedError();
    }

    const token = this.extractToken(upstream.body);
    const expiresAt = this.extractExpiresAt(upstream.body);

    // Verify token
    const principal = verifyAuthToken(this.deps.config.authPublicKeyPem, token, {
      now,
      expectedIssuer: this.deps.config.jwtIssuer,
      expectedAudience: this.deps.config.jwtAudience,
    });

    if (principal === null || principal.kind !== 'officer') {
      throw new Error('Token verification failed');
    }

    // Create session
    const issued = await this.deps.sessions.create(
      {
        kind: 'officer',
        subjectId: principal.subjectId,
        agency: principal.agency,
        roles: principal.roles,
        upstreamCredential: token,
        upstreamExpiresAt: expiresAt,
      },
      now
    );

    this.deps.audit.log({
      action: 'EDGE_SESSION_ISSUED',
      correlationId: command.correlationId,
      sessionId: issued.session.sessionId,
      subjectId: principal.subjectId,
      agency: principal.agency,
      sessionKind: 'officer',
    });

    return {
      handle: issued.handle,
      csrfToken: issued.csrfToken,
    };
  }

  private targetBucketKey(loginHandle: string): string {
    // Implementation from current rate-limiter.ts
    // ...
  }

  private extractToken(body: unknown): string {
    // Safe extraction with validation
    // ...
  }

  private extractExpiresAt(body: unknown): string | null {
    // Safe extraction with validation
    // ...
  }
}
```

### 5.4 Adapter Layer Implementation

Controllers become thin adapters:

#### File: `adapters/http/officer-auth.controller.ts` (Refactored)
```typescript
import type { HttpResult, RouteHandler } from '@usrp/shared-http';
import type { OfficerAuthService } from '../../application/officer-auth.service.js';
import type { EdgeDeps } from './guards.js';
import { sessionCookies, clearedCookies } from './middleware/cookies.js';
import { readJsonBody, requireBoundedString } from './validation.js';
import { CREDENTIAL_REJECTED } from './outcomes.js';
import { withAnonymous } from './guards.js';
import { AuthenticationFailedError, RateLimitExceededError } from '../../domain/edge.errors.js';

export function officerLoginHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'officerLogin', async (ctx): Promise<HttpResult> => {
    const body = await readJsonBody(ctx);
    const loginHandle = requireBoundedString(body.loginHandle, 'loginHandle', 128);
    const password = requireBoundedString(body.password, 'password', 256);

    try {
      const result = await deps.officerAuth.login(
        {
          loginHandle,
          password,
          correlationId: ctx.correlationId,
          clientKey: clientBucketKey(ctx, deps.config.rateLimits.trustedProxyHops),
        },
        deps.now()
      );

      return {
        status: 204,
        cookies: sessionCookies(deps.cookies, result.handle, result.csrfToken),
      };
    } catch (err) {
      if (err instanceof AuthenticationFailedError) {
        return CREDENTIAL_REJECTED;
      }
      if (err instanceof RateLimitExceededError) {
        return {
          status: 429,
          headers: { 'retry-after': String(err.retryAfterSeconds) },
          body: { error: 'RATE_LIMIT_EXCEEDED' },
        };
      }
      throw err;
    }
  });
}
```

---

## 6. Benefits of Refactoring

### 6.1 Architectural Benefits
1. **Consistency**: All microservices follow the same hexagonal pattern
2. **Maintainability**: Clear separation of concerns, easier to understand
3. **Testability**: Application layer can be tested without HTTP/database
4. **Flexibility**: Easy to swap implementations (e.g., Redis session store)
5. **Onboarding**: New developers see consistent patterns across services

### 6.2 Technical Benefits
1. **Dependency Inversion**: Core logic doesn't depend on infrastructure
2. **Unit Testing**: Application services can be tested in isolation
3. **Integration Testing**: Adapters can be tested against port contracts
4. **Refactoring Safety**: Changes to adapters don't affect application logic
5. **Code Reuse**: Application services can be reused in different contexts

### 6.3 Operational Benefits
1. **Debugging**: Clear boundaries make issues easier to trace
2. **Performance**: Can optimize adapters without touching business logic
3. **Monitoring**: Port interfaces are natural instrumentation points
4. **Documentation**: Architecture self-documents through layer structure

---

## 7. Testing Strategy

### 7.1 Unit Tests
```typescript
// Test application services with mock ports
describe('OfficerAuthService', () => {
  it('should create session on successful login', async () => {
    const mockUpstream = { call: jest.fn().mockResolvedValue({ status: 200, body: { token: '...' } }) };
    const mockSessions = { create: jest.fn().mockResolvedValue({ ... }) };
    const service = new OfficerAuthService({ upstream: mockUpstream, sessions: mockSessions, ... });
    
    await service.login({ ... });
    
    expect(mockSessions.create).toHaveBeenCalled();
  });
});
```

### 7.2 Integration Tests
```typescript
// Test adapters against real dependencies
describe('PgSessionRepository', () => {
  it('should persist and retrieve session', async () => {
    const repo = new PgSessionRepository();
    const result = await repo.create({ ... }, new Date());
    const retrieved = await repo.findByHandle(result.handleHash, new Date());
    expect(retrieved.sessionId).toBe(result.session.sessionId);
  });
});
```

### 7.3 Contract Tests
```typescript
// Verify adapters implement port interfaces correctly
describe('SessionRepository contract', () => {
  const implementations = [
    new PgSessionRepository(),
    new InMemorySessionRepository(), // for testing
  ];

  implementations.forEach((repo) => {
    it('should implement create operation', async () => {
      const result = await repo.create({ ... }, new Date());
      expect(result).toHaveProperty('session');
      expect(result).toHaveProperty('handle');
    });
  });
});
```

---

## 8. Migration Checklist

### Phase 1: Structure Setup
- [ ] Create `domain/` directory
- [ ] Create `application/` directory
- [ ] Create `ports/` directory
- [ ] Reorganize `adapters/` directory
- [ ] Extract domain types to `domain/session.types.ts`
- [ ] Extract domain errors to `domain/edge.errors.ts`
- [ ] Move registries to `domain/edge-operations.ts` and `domain/upstream-operations.ts`
- [ ] Define port interfaces

### Phase 2: Application Services
- [ ] Implement `SessionManagementService`
- [ ] Implement `OfficerAuthService`
- [ ] Implement `ApplicantAuthService`
- [ ] Implement `UpstreamProxyService`
- [ ] Write unit tests for application services
- [ ] Refactor controllers to use application services

### Phase 3: Adapters
- [ ] Move `PgEdgeSessionStore` to `adapters/session-store.pg-repository.ts`
- [ ] Move `UpstreamClient` to `adapters/upstream.http-gateway.ts`
- [ ] Move `FixedWindowRateLimiter` to `adapters/fixed-window-rate-limiter.ts`
- [ ] Create `adapters/credential-cipher.adapter.ts`
- [ ] Create `adapters/audit-logger.adapter.ts`
- [ ] Update composition root in `index.ts`

### Phase 4: Cleanup
- [ ] Remove old directory structure
- [ ] Update all imports
- [ ] Run all tests
- [ ] Run selfchecks
- [ ] Update documentation
- [ ] Code review
- [ ] Merge to main

---

## 9. Risk Mitigation

### 9.1 Identified Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Breaking existing functionality | Medium | High | Comprehensive test coverage, parallel structure during migration |
| Session store migration issues | Low | High | Keep existing implementation, only move files |
| Performance regression | Low | Medium | Benchmark before/after, profile critical paths |
| Merge conflicts during refactor | High | Low | Feature branch, frequent rebases, clear communication |

### 9.2 Rollback Plan
1. Entire refactoring on feature branch `feat/edge-gateway-hexagonal`
2. Each phase is a separate commit with passing tests
3. Can revert to any phase if issues discovered
4. Production deployment only after full test suite passes

---

## 10. Success Criteria

### 10.1 Architecture
- [ ] Edge gateway follows hexagonal architecture
- [ ] All layers properly separated (domain/application/ports/adapters)
- [ ] Dependency direction is inward (adapters → ports → application → domain)
- [ ] No circular dependencies

### 10.2 Testing
- [ ] All existing tests pass
- [ ] Application services have unit tests (>80% coverage)
- [ ] Adapters have integration tests
- [ ] Selfchecks pass

### 10.3 Documentation
- [ ] Architecture documented
- [ ] Refactoring recorded in ADR
- [ ] Code comments updated
- [ ] README updated

### 10.4 Operational
- [ ] No functional changes
- [ ] No API contract changes
- [ ] No performance degradation
- [ ] Logs and monitoring unchanged

---

## 11. Timeline

| Phase | Duration | Milestone |
|-------|----------|-----------|
| Phase 1: Structure | 1 day | Hexagonal skeleton created |
| Phase 2: Application Layer | 2 days | Application services implemented, controllers refactored |
| Phase 3: Adapters | 1 day | All adapters implementing ports |
| Phase 4: Cleanup | 0.5 days | Old structure removed, docs updated |
| **Total** | **4.5 days** | **Hexagonal edge-gateway ready for production** |

---

## 12. Recommendation

**I recommend proceeding with this refactoring for the following reasons:**

1. **Architectural Debt**: The edge-gateway is the only service not following the platform standard
2. **Maintainability**: Current structure makes it hard to test and modify
3. **Team Velocity**: Inconsistent architecture slows down development
4. **Risk**: Can be done incrementally with minimal disruption
5. **ROI**: 4.5 days investment for long-term maintainability

**Next Steps**:
1. Review this document with the team
2. Get approval from stakeholders
3. Create feature branch `feat/edge-gateway-hexagonal`
4. Begin Phase 1 implementation
5. Daily standups to track progress

---

**Document Version**: 1.0  
**Last Updated**: 2024-09-22  
**Reviewed By**: Pending  
**Approved By**: Pending
