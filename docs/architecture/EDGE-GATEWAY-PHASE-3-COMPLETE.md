# Edge Gateway Hexagonal Architecture - Phase 3 Complete

**Status**: Adapters layer completed, moving to Phase 4 (Composition Root & Controllers)

---

## ✅ Phase 3 Completed: Adapter Implementations

All adapters now properly implement their port interfaces:

### 1. Session Repository Adapter ✅
**File**: `adapters/session-store.pg-repository.ts`
- ✅ Implements `SessionRepository` port
- ✅ Maintains all original PostgreSQL logic
- ✅ Proper RLS enforcement (usrp_edge_gateway role)
- ✅ Credential encryption/decryption
- ✅ Session lifecycle (create, findByHandle, touch, revoke, deleteExpired, stats)
- ✅ Rotation grace window support
- ✅ Write throttling on touch (60s granularity)

### 2. Upstream Gateway Adapter ✅
**File**: `adapters/upstream.http-gateway.ts`
- ✅ Implements `UpstreamGateway` port
- ✅ HTTP/fetch transport to backend microservices
- ✅ Four hard rules enforced:
  - No retries
  - No header forwarding
  - Bounded time and bytes
  - Named fault codes only
- ✅ G2G error code mapping
- ✅ Credential validation per operation

### 3. Rate Limiter Adapter ✅
**File**: `adapters/fixed-window-rate-limiter.ts`
- ✅ Implements `RateLimiter` port
- ✅ In-memory fixed-window algorithm
- ✅ Per-target and per-client buckets
- ✅ Automatic sweeping at threshold
- ✅ Returns `RateLimitCheck` with remainingTokens

### 4. Credential Cipher Adapter ✅
**File**: `adapters/credential-cipher.adapter.ts`
- ✅ Implements `CredentialCipher` port (extended)
- ✅ Uses @usrp/shared-security for AES-256-GCM
- ✅ HMAC-based key derivation with domain separation
- ✅ Handle hashing, CSRF token generation
- ✅ Credential encryption (seal) and decryption (open)

### 5. Audit Logger Adapter ✅
**File**: `adapters/audit-logger.adapter.ts`
- ✅ Implements `AuditLogger` port
- ✅ Structured JSON logging to stdout
- ✅ Session stats logging
- ✅ Backward-compatible exports (auditEdge, auditEdgeStats, redact)

---

## 🎯 Architecture Compliance Achieved

### Dependency Direction: Inward ✅
```
adapters → ports → application → domain
```

### Port Interfaces: Pure TypeScript ✅
- No implementations in ports/
- All interfaces defined
- Adapters implement ports

### Original Engineering Preserved ✅
- All PostgreSQL queries unchanged
- RLS enforcement maintained
- Security posture intact
- Performance optimizations preserved
- Error handling unchanged

---

## 📋 Phase 4: Composition Root & Controllers

### Next Steps

#### 1. Update Composition Root (`index.ts`)

**Current exports to maintain**:
```typescript
export { EDGE_SERVICE_NAME, loadEdgeGatewayConfig, type EdgeGatewayConfig } from './config.js';
export {
  EDGE_OPERATIONS,
  EDGE_OPERATION_IDS,
  PUBLIC_ALLOWLIST,
  REACHABLE_UPSTREAM_IDS,
  edgeOperation,
  type EdgeOperation,
  type EdgeOperationId,
} from './domain/edge-operations.js';
export {
  BROKERED_SERVICE_INTERNAL,
  UPSTREAM,
  type UpstreamOperation,
  type UpstreamOperationId,
} from './domain/upstream-operations.js';
export { edgeHandlers, edgeRoutes } from './routes.js';
export { redact } from './adapters/audit-logger.adapter.js';
export { deriveCredentialKey } from './adapters/credential-cipher.adapter.js';
export { PgEdgeSessionStore } from './adapters/session-store.pg-repository.ts';
export { toSessionView, type EdgeSession, type SessionView } from './domain/session.types.js';
```

**New `createEdgeGateway` function**:
```typescript
export function createEdgeGateway(
  config: EdgeGatewayConfig = loadEdgeGatewayConfig(),
  now: () => Date = () => new Date(),
): EdgeGateway {
  // 1. Create infrastructure adapters
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

  // 2. Create application services
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

  // 3. Assemble EdgeDeps for controllers
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

#### 2. Update `EdgeDeps` Interface

**Location**: `adapters/http/guards.ts` or move to `index.ts`

```typescript
export interface EdgeDeps {
  readonly config: EdgeGatewayConfig;
  readonly cookies: CookiePolicy;
  
  // Application Services (NEW)
  readonly sessionManagement: SessionManagementService;
  readonly officerAuth: OfficerAuthService;
  readonly applicantAuth: ApplicantAuthService;
  readonly upstreamProxy: UpstreamProxyService;
  
  // Infrastructure (for guards and utilities)
  readonly sessions: SessionRepository;
  readonly limiter: RateLimiter;
  readonly now: () => Date;
}
```

#### 3. Refactor HTTP Controllers

**Pattern**: Thin controllers that delegate to application services

**Example - Officer Auth Controller**:
```typescript
// OLD: Logic embedded in controller
export function officerLoginHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'officerLogin', async (ctx) => {
    // Rate limiting logic
    // Upstream call logic
    // Token verification logic
    // Session creation logic
    // All mixed in controller
  });
}

// NEW: Thin controller delegating to service
export function officerLoginHandler(deps: EdgeDeps): RouteHandler {
  return withAnonymous(deps, 'officerLogin', async (ctx) => {
    const body = await readJsonBody(ctx);
    const loginHandle = requireBoundedString(body.loginHandle, 'loginHandle', 128);
    const password = requireBoundedString(body.password, 'password', 256);

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

      return {
        status: 204,
        cookies: sessionCookies(deps.cookies, result.handle, result.csrfToken),
      };
    } catch (err) {
      return mapAuthError(err);
    }
  });
}

function mapAuthError(err: unknown): HttpResult {
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
```

#### 4. Controllers to Refactor

**Priority Order**:
1. ✅ `session.controller.ts` - Session read/refresh
2. ✅ `officer-auth.controller.ts` - Officer login/logout
3. ✅ `applicant-auth.controller.ts` - Applicant OTP flow
4. `identity.controller.ts` - Identity verification proxy
5. `citizen.controller.ts` - Citizen self-service
6. `walk-in.controller.ts` - Walk-in registration
7. `field-sync.controller.ts` - Field device sync
8. `officer-reads.controller.ts` - Officer read operations
9. `officer-transitions.controller.ts` - Officer write operations

---

## 🔄 Migration Strategy

### Incremental Rollout
1. Wire up composition root with new services
2. Keep old implementations in place temporarily
3. Refactor controllers one by one
4. Test each controller after refactoring
5. Remove old code only after all tests pass

### Testing Approach
- Unit test application services (mocked ports)
- Integration test adapters (real dependencies)
- E2E test controllers (full stack)

---

## 📊 Current Progress: ~65% Complete

- ✅ Phase 1: Domain & Ports (100%)
- ✅ Phase 2: Application Services (100%)
- ✅ Phase 3: Adapters (100%)
- 🔄 Phase 4: Composition & Controllers (0%)

**Estimated Remaining Time**: 4-6 hours
