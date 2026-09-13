// ══════════════════════════════════════════════════════════════════
// edge-gateway — What the controllers are handed
//
// One interface so every route is assembled from the same wiring and a new
// dependency cannot quietly appear in one controller only.
// ══════════════════════════════════════════════════════════════════

import type { EdgeSessionService } from '../../application/session.service.js';
import type { ApplicationGateway, IamGateway, IdentityGateway } from '../../ports/upstream.js';
import type { RateLimiter } from './rate-limit.js';

export interface EdgeDeps {
  readonly sessions: EdgeSessionService;
  readonly iam: IamGateway;
  readonly identity: IdentityGateway;
  readonly applications: ApplicationGateway;
  readonly limiter: RateLimiter;
  /** MUST be true in production — the __Host- prefix requires it. */
  readonly secureCookies: boolean;
  /** Max-Age for a pre-session CSRF cookie. */
  readonly preSessionTtlSeconds: number;
}
