# Edge Gateway Hexagonal Architecture - Implementation Progress

**Date**: 2024-09-22  
**Status**: Phase 1 & 2 Completed, Phase 3 In Progress

---

## Completed Work

### ✅ Phase 1: Hexagonal Structure (COMPLETED)

**Directories Created:**
- `services/edge-gateway/src/domain/`
- `services/edge-gateway/src/application/`
- `services/edge-gateway/src/ports/`
- `services/edge-gateway/src/adapters/http/middleware/`

**Domain Layer Files Created:**
- ✅ `domain/edge-operations.ts` - Copied from registry/edge-operations.ts
- ✅ `domain/upstream-operations.ts` - Copied from registry/upstream-operations.ts
- ✅ `domain/session.types.ts` - Session domain entities
- ✅ `domain/edge.errors.ts` - Domain-specific errors

**Port Interfaces Created:**
- ✅ `ports/session-repository.ts` - Session persistence interface
- ✅ `ports/rate-limiter.ts` - Rate limiting interface
- ✅ `ports/credential-cipher.ts` - Credential encryption interface
- ✅ `ports/upstream-gateway.ts` - Upstream communication interface
- ✅ `ports/audit-logger.ts` - Audit logging interface

### ✅ Phase 2: Application Services (COMPLETED)

**Application Layer Files Created:**
- ✅ `application/session-management.service.ts` - Session lifecycle use case
- ✅ `application/officer-auth.service.ts` - Officer authentication use case
- ✅ `application/applicant-auth.service.ts` - Applicant authentication use case
- ✅ `application/upstream-proxy.service.ts` - Upstream proxying use case

### 🔄 Phase 3: Adapters (IN PROGRESS)

**Adapter Files Created:**
- ✅ `adapters/audit-logger.adapter.ts` - Console audit logger implementation
- ✅ `adapters/credential-cipher.adapter.ts` - Node crypto implementation
- 🔄 `adapters/session-store.pg-repository.ts` - PostgreSQL session store (needs interface updates)
- 🔄 `adapters/upstream.http-gateway.ts` - HTTP upstream client (needs interface updates)
- 🔄 `adapters/fixed-window-rate-limiter.ts` - In-memory rate limiter (needs interface updates)

---

## Remaining Work

### Phase 3: Complete Adapter Implementations

#### 1. Update `adapters/session-store.pg-repository.ts`

**Current Status**: File copied, needs interface alignment

**Required Changes**:
```typescript
// Change class declaration to implement SessionRepository
export class PgEdgeSessionStore implements SessionRepository {

// Update imports
import type {
  SessionRepository,
  CreateSessionInput,
  CreateSessionResult,
  SessionLookupResult,
  SessionStats,
} from '../ports/session-repository.js';

// Update method signatures to match port interface:
- async create(...): Promise<IssuedSession> → Promise<CreateSessionResult>
- async resolve(...): Promise<SessionLookup> → async findByHandle(...): Promise<SessionLookupResult>
- async deleteExpired(...): Promise<number> → (already matches)
- async stats(...): Promise<SessionStoreStats> → Promise<SessionStats>
- Add: async touch(sessionId: string, now: Date): Promise<void>
- Add: async revoke(sessionId: string, reason: string, now: Date): Promise<void>
```

#### 2. Update `adapters/upstream.http-gateway.ts`

**Required Changes**:
```typescript
// Change class declaration
export class UpstreamClient implements UpstreamGateway {

// Update imports
import type { UpstreamGateway, UpstreamCallInput, UpstreamResult } from '../ports/upstream-gateway.js';
import { UpstreamUnavailableError } from '../domain/edge.errors.js';

// Verify call() method signature matches port interface
```

#### 3. Update `adapters/fixed-window-rate-limiter.ts`

**Required Changes**:
```typescript
// Change class declaration
export class FixedWindowRateLimiter implements RateLimiter {

// Update imports
import type { RateLimiter, RateLimitCheck } from '../ports/rate-limiter.js';

// Update method signature to match port
check(bucketKey: string, limit: number): RateLimitCheck
```

#### 4. Update HTTP Controllers

**Controllers to Refactor** (currently in /tmp/):
- `applicant-auth.controller.ts`
- `officer-auth.controller.ts`
- `session.controller.ts`
- `identity.controller.ts`
- `citizen.controller.ts`
- `walk-in.controller.ts`
- `field-sync.controller.ts`
- `officer-reads.controller.ts`
- `officer-transitions.controller.ts`

**Pattern for Refactoring**:
```typescript
// OLD (current pattern)
export function officerLoginHandler(deps: EdgeDeps): RouteHandler {
  // Logic mixed with HTTP handling
}

// NEW (hexagonal pattern)
export function officerLoginHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'officerLogin', async (ctx): Promise<HttpResult> => {
    // 1. Extract and validate input
    const body = await readJsonBody(ctx);
    const loginHandle = requireBoundedString(body.loginHandle, 'loginHandle', 128);
    const password = requireBoundedString(body.password, 'password', 256);

    // 2. Call application service
    try {
      const result = await deps.officerAuth.login(
        {
          loginHandle,
          password,
          correlationId: ctx.correlationId,
          clientBucketKey: clientBucketKey(ctx, deps.config.rateLimits.trustedProxyHops),
        },
        deps.now()
      );

      // 3. Map result to HTTP response
      return {
        status: 204,
        cookies: sessionCookies(deps.cookies, result.handle, result.csrfToken),
      };
    } catch (err) {
      // 4. Map domain errors to HTTP status codes
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

### Phase 4: Update Composition Root

**File**: `services/edge-gateway/src/index.ts`

**Required Changes**:
```typescript
import { createAuditLogger } from './adapters/audit-logger.adapter.js';
import { createCredentialCipher } from './adapters/credential-cipher.adapter.js';
import { PgEdgeSessionStore } from './adapters/session-store.pg-repository.ts';
import { UpstreamClient } from './adapters/upstream.http-gateway.js';
import { FixedWindowRateLimiter } from './adapters/fixed-window-rate-limiter.js';

import { SessionManagementService } from './application/session-management.service.js';
import { OfficerAuthService } from './application/officer-auth.service.js';
import { ApplicantAuthService } from './application/applicant-auth.service.js';
import { UpstreamProxyService } from './application/upstream-proxy.service.js';

export interface EdgeDeps {
  readonly config: EdgeGatewayConfig;
  readonly cookies: CookiePolicy;
  
  // Application Services
  readonly sessionManagement: SessionManagementService;
  readonly officerAuth: OfficerAuthService;
  readonly applicantAuth: ApplicantAuthService;
  readonly upstreamProxy: UpstreamProxyService;
  
  // Infrastructure (for guards and middleware)
  readonly sessions: SessionRepository;
  readonly limiter: RateLimiter;
  readonly now: () => Date;
}

export function createEdgeGateway(
  config: EdgeGatewayConfig = loadEdgeGatewayConfig(),
  now: () => Date = () => new Date(),
): EdgeGateway {
  // Create adapters (ports implementations)
  const cipher = createCredentialCipher(config.session.handleHmacKey);
  const sessions = new PgEdgeSessionStore(
    {
      handleHmacKey: config.session.handleHmacKey,
      idleTtlSeconds: config.session.idleTtlSeconds,
      absoluteTtlSeconds: config.session.absoluteTtlSeconds,
    },
    cipher,
  );
  const upstream = new UpstreamClient(config.upstream);
  const limiter = new FixedWindowRateLimiter();
  const audit = createAuditLogger();

  // Create application services
  const sessionManagement = new SessionManagementService({
    repository: sessions,
    cipher,
    audit,
  });

  const officerAuth = new OfficerAuthService({
    sessions,
    upstream,
    limiter,
    audit,
    cipher,
    config: {
      authPublicKeyPem: config.auth.authPublicKeyPem,
      jwtIssuer: config.auth.jwtIssuer,
      jwtAudience: config.auth.jwtAudience,
      handleHmacKey: config.session.handleHmacKey,
      loginRateLimit: config.rateLimits.loginPerMinute,
    },
  });

  const applicantAuth = new ApplicantAuthService({
    sessions,
    upstream,
    limiter,
    audit,
    config: {
      otpRequestRateLimit: config.rateLimits.otpPerMinute,
      otpVerifyRateLimit: config.rateLimits.otpPerMinute,
    },
  });

  const upstreamProxy = new UpstreamProxyService({ upstream });

  const deps: EdgeDeps = {
    config,
    cookies: cookiePolicy(config.session.secureCookies),
    sessionManagement,
    officerAuth,
    applicantAuth,
    upstreamProxy,
    sessions,
    limiter,
    now,
  };

  return { deps, routes: edgeRoutes(deps), cors: edgeCorsPolicy(config) };
}
```

---

## Testing Strategy

### Unit Tests (Application Layer)

```typescript
// Test session management service
describe('SessionManagementService', () => {
  it('should read active session', async () => {
    const mockRepo = {
      findByHandle: jest.fn().mockResolvedValue({
        kind: 'ACTIVE',
        session: { /* mock session */ },
      }),
    };
    const service = new SessionManagementService({
      repository: mockRepo,
      cipher: mockCipher,
      audit: mockAudit,
    });
    
    const result = await service.readSession('handle', new Date());
    expect(result).not.toBeNull();
  });
});

// Test officer auth service
describe('OfficerAuthService', () => {
  it('should create session on successful login', async () => {
    const mockUpstream = {
      call: jest.fn().mockResolvedValue({
        status: 200,
        body: { token: 'jwt...' },
      }),
    };
    // ... test implementation
  });
});
```

### Integration Tests (Adapters)

```typescript
// Test PostgreSQL session repository
describe('PgEdgeSessionStore', () => {
  it('should persist and retrieve session', async () => {
    const store = new PgEdgeSessionStore(config, cipher);
    const result = await store.create({ /* input */ }, new Date());
    const lookup = await store.findByHandle(result.handle, new Date());
    expect(lookup.kind).toBe('ACTIVE');
  });
});
```

---

## File Migration Checklist

### To Delete (After Verification)
- [ ] `src/session/` directory (replaced by domain types + adapters)
- [ ] `src/registry/` directory (moved to domain/)
- [ ] `src/upstream/` directory (moved to adapters/)
- [ ] `src/security/rate-limiter.ts` (moved to adapters/)
- [ ] `src/security/credential-cipher.ts` (moved to adapters/)
- [ ] `src/observability/audit-log.ts` (replaced by adapter)

### To Keep
- ✅ `src/security/csrf.ts` - Utility functions (or move to adapters/http/middleware/)
- ✅ `src/security/cookies.ts` - Utility functions (or move to adapters/http/middleware/)
- ✅ `src/adapters/http/guards.ts` - HTTP middleware
- ✅ `src/adapters/http/validation.ts` - HTTP middleware
- ✅ `src/adapters/http/outcomes.ts` - HTTP response mapping
- ✅ `src/adapters/http/projections.ts` - Response transformations
- ✅ `src/adapters/http/leak-guard.ts` - Security middleware

---

## Next Steps

1. **Complete adapter interface alignments** (2-3 hours)
   - Update PgEdgeSessionStore to implement SessionRepository
   - Update UpstreamClient to implement UpstreamGateway
   - Update FixedWindowRateLimiter to implement RateLimiter

2. **Refactor HTTP controllers** (3-4 hours)
   - Update all controllers to use application services
   - Map domain errors to HTTP status codes
   - Keep controllers thin (input validation + service call + response mapping)

3. **Update composition root** (1 hour)
   - Wire all dependencies in index.ts
   - Update EdgeDeps interface
   - Update routes.ts to use new deps structure

4. **Run tests and fix issues** (2-3 hours)
   - Run existing test suite
   - Fix import paths
   - Fix type errors
   - Ensure all tests pass

5. **Update imports across codebase** (1 hour)
   - Update all files importing from old locations
   - Use find/replace for common patterns
   - Fix any circular dependency issues

6. **Run selfchecks** (30 minutes)
   - `selfcheck/verify-edge-security.ts`
   - `selfcheck/verify-edge-contract.ts`
   - Fix any issues

7. **Documentation and cleanup** (1 hour)
   - Update inline documentation
   - Remove old files
   - Update README if needed
   - Git commit with clear message

---

## Key Principles to Maintain

1. **Dependency Direction**: Always inward (adapters → ports → application → domain)
2. **Port Purity**: Ports are interfaces only, zero implementation
3. **Thin Controllers**: HTTP layer only handles HTTP concerns
4. **Domain Errors**: Business logic throws domain errors, adapters map to HTTP
5. **Testability**: Application services testable without HTTP/database

---

## Success Metrics

- [ ] All existing tests pass
- [ ] Selfchecks pass
- [ ] No functional changes (API contracts unchanged)
- [ ] All layers properly separated
- [ ] No circular dependencies
- [ ] Application services have >80% test coverage

---

**Estimated Remaining Time**: 8-12 hours for complete implementation

**Current Progress**: ~40% complete (Phase 1 & 2 done, Phase 3 & 4 remaining)
