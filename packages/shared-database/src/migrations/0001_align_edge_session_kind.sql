-- 0001 — create the edge_sessions table (ADR-021)
--
-- Was previously a partial file containing only the "align kind to text"
-- ALTER, which silently depended on rls/0019_edge_sessions.sql having
-- already created the table first. That's backwards: drizzle-kit migrate
-- always runs before the rls/ scripts, so a fresh database had nothing
-- to alter. This file now creates the table directly with its final,
-- correct shape — no follow-up ALTER needed.
CREATE TABLE "public_core"."edge_sessions" (
  "session_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "handle_hash" varchar(64) NOT NULL,
  "previous_handle_hash" varchar(64),
  "previous_csrf_token_hash" varchar(64),
  "previous_valid_until" timestamp with time zone,
  "csrf_token_hash" varchar(64) NOT NULL,
  "kind" text NOT NULL,
  "subject_id" uuid,
  "agency" "public_core"."agency",
  "roles" text[] NOT NULL DEFAULT '{}',
  "upstream_credential" text NOT NULL,
  "upstream_expires_at" timestamp with time zone,
  "issued_at" timestamp with time zone NOT NULL DEFAULT now(),
  "idle_expires_at" timestamp with time zone NOT NULL,
  "absolute_expires_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "rotated_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_reason" varchar(32),
  CONSTRAINT "edge_sessions_handle_hash_unique" UNIQUE("handle_hash"),
  CONSTRAINT "edge_sessions_officer_shape" CHECK (
    (kind = 'officer' AND agency IS NOT NULL AND subject_id IS NOT NULL)
    OR (kind = 'applicant' AND agency IS NULL)
  ),
  CONSTRAINT "edge_sessions_ttl_order" CHECK (absolute_expires_at >= idle_expires_at)
);
--> statement-breakpoint
CREATE INDEX "idx_pc_edge_sessions_prev_handle" ON "public_core"."edge_sessions" ("previous_handle_hash") WHERE previous_handle_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_pc_edge_sessions_absolute" ON "public_core"."edge_sessions" ("absolute_expires_at");