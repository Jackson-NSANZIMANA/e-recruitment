-- BUILD-001 — Campaign & Policy Control Plane schema.
-- The application-service owns campaign/policy/publication/history records;
-- scheduling-service owns the session/coverage command records. Authorization,
-- append-only triggers, state-machine enforcement and RLS are in rls/0026.

ALTER TABLE "public_core"."recruitment_campaigns"
  ADD COLUMN "public_code" varchar(64),
  ADD COLUMN "target_districts" jsonb,
  ADD COLUMN "current_policy_version_id" uuid,
  ADD COLUMN "registration_closed_at" timestamp with time zone,
  ADD COLUMN "cancelled_at" timestamp with time zone;
--> statement-breakpoint

-- Preserve historical rows. Derive their known district set from existing
-- venue assignments; rows without venues remain NULL rather than pretending
-- that an empty target was an approved target.
UPDATE "public_core"."recruitment_campaigns"
SET "public_code" = 'LEGACY-' || upper(replace("id"::text, '-', ''))
WHERE "public_code" IS NULL;
--> statement-breakpoint

UPDATE "public_core"."recruitment_campaigns" AS c
SET "target_districts" = (
  SELECT jsonb_agg(v."district" ORDER BY v."district")
  FROM "public_core"."campaign_venue_assignments" AS v
  WHERE v."campaign_id" = c."id"
)
WHERE c."target_districts" IS NULL
  AND EXISTS (
    SELECT 1 FROM "public_core"."campaign_venue_assignments" AS v
    WHERE v."campaign_id" = c."id"
  );
--> statement-breakpoint

ALTER TABLE "public_core"."recruitment_campaigns"
  ALTER COLUMN "public_code" SET NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX "idx_pc_campaign_public_code"
  ON "public_core"."recruitment_campaigns" USING btree ("public_code");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pc_campaign_id_agency"
  ON "public_core"."recruitment_campaigns" USING btree ("id", "agency");
--> statement-breakpoint

ALTER TABLE "public_core"."recruitment_campaigns"
  ADD CONSTRAINT "campaign_public_code_format_check"
    CHECK ("public_code" ~ '^[A-Z0-9][A-Z0-9-]{2,63}$'),
  ADD CONSTRAINT "campaign_target_districts_array_check"
    CHECK ("target_districts" IS NULL OR jsonb_typeof("target_districts") = 'array');
--> statement-breakpoint

CREATE TABLE "public_core"."campaign_policy_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL,
  "agency" "public_core"."agency" NOT NULL,
  "version_number" integer NOT NULL,
  "policy_document" jsonb NOT NULL,
  "policy_hash" varchar(64) NOT NULL,
  "hash_version" integer NOT NULL,
  "legal_basis_code" varchar(64) NOT NULL,
  "legal_basis_reference" varchar(256) NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_policy_versions_campaign_agency_fk"
    FOREIGN KEY ("campaign_id", "agency")
    REFERENCES "public_core"."recruitment_campaigns" ("id", "agency")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "campaign_policy_versions_version_positive_check"
    CHECK ("version_number" > 0),
  CONSTRAINT "campaign_policy_versions_hash_check"
    CHECK ("policy_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "campaign_policy_versions_hash_version_check"
    CHECK ("hash_version" = 1),
  CONSTRAINT "campaign_policy_versions_document_object_check"
    CHECK (jsonb_typeof("policy_document") = 'object'),
  CONSTRAINT "campaign_policy_versions_legal_basis_check"
    CHECK (length(btrim("legal_basis_code")) > 0 AND length(btrim("legal_basis_reference")) > 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX "idx_pc_policy_campaign_version"
  ON "public_core"."campaign_policy_versions" USING btree ("campaign_id", "version_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pc_policy_id_campaign_agency"
  ON "public_core"."campaign_policy_versions" USING btree ("id", "campaign_id", "agency");
--> statement-breakpoint
CREATE INDEX "idx_pc_policy_campaign"
  ON "public_core"."campaign_policy_versions" USING btree ("campaign_id");
--> statement-breakpoint

ALTER TABLE "public_core"."recruitment_campaigns"
  ADD CONSTRAINT "campaign_current_policy_same_campaign_fk"
    FOREIGN KEY ("current_policy_version_id", "id", "agency")
    REFERENCES "public_core"."campaign_policy_versions" ("id", "campaign_id", "agency")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint

CREATE TABLE "public_core"."campaign_publications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL,
  "agency" "public_core"."agency" NOT NULL,
  "public_code" varchar(64) NOT NULL,
  "policy_version_id" uuid NOT NULL,
  "coverage_version" integer NOT NULL,
  "coverage_hash" varchar(64) NOT NULL,
  "publication_event_id" uuid NOT NULL,
  "published_by" uuid NOT NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_publications_campaign_agency_fk"
    FOREIGN KEY ("campaign_id", "agency")
    REFERENCES "public_core"."recruitment_campaigns" ("id", "agency")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "campaign_publications_policy_campaign_fk"
    FOREIGN KEY ("policy_version_id", "campaign_id", "agency")
    REFERENCES "public_core"."campaign_policy_versions" ("id", "campaign_id", "agency")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "campaign_publications_coverage_version_check"
    CHECK ("coverage_version" > 0),
  CONSTRAINT "campaign_publications_coverage_hash_check"
    CHECK ("coverage_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "campaign_publications_event_unique"
    UNIQUE ("publication_event_id")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "idx_pc_publication_campaign"
  ON "public_core"."campaign_publications" USING btree ("campaign_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pc_publication_id_campaign_agency"
  ON "public_core"."campaign_publications" USING btree ("id", "campaign_id", "agency");
--> statement-breakpoint
CREATE INDEX "idx_pc_publication_agency_published"
  ON "public_core"."campaign_publications" USING btree ("agency", "published_at");
--> statement-breakpoint

CREATE TABLE "public_core"."campaign_lifecycle_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL,
  "agency" "public_core"."agency" NOT NULL,
  "from_status" "public_core"."campaign_status",
  "to_status" "public_core"."campaign_status" NOT NULL,
  "actor_id" uuid NOT NULL,
  "correlation_id" varchar(128) NOT NULL,
  "reason_code" varchar(64),
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_lifecycle_history_campaign_agency_fk"
    FOREIGN KEY ("campaign_id", "agency")
    REFERENCES "public_core"."recruitment_campaigns" ("id", "agency")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "campaign_lifecycle_history_legal_edge_check"
    CHECK (
      ("from_status" IS NULL AND "to_status" = 'DRAFT') OR
      ("from_status" IS NOT NULL AND "from_status" = 'DRAFT' AND "to_status" IN ('REGISTRATION_OPEN', 'CANCELLED')) OR
      ("from_status" IS NOT NULL AND "from_status" = 'REGISTRATION_OPEN' AND "to_status" IN ('REGISTRATION_CLOSED', 'CANCELLED')) OR
      ("from_status" IS NOT NULL AND "from_status" = 'REGISTRATION_CLOSED' AND "to_status" = 'COMPLETED')
    )
);
--> statement-breakpoint

CREATE INDEX "idx_pc_campaign_history_campaign_time"
  ON "public_core"."campaign_lifecycle_history" USING btree ("campaign_id", "occurred_at");
--> statement-breakpoint

CREATE TABLE "public_core"."campaign_command_requests" (
  "command_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" uuid NOT NULL,
  "agency" "public_core"."agency" NOT NULL,
  "operation" varchar(48) NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "resource_id" uuid NOT NULL,
  "response_status" integer NOT NULL,
  "response_body" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_command_requests_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "campaign_command_requests_response_status_check"
    CHECK ("response_status" BETWEEN 200 AND 299),
  CONSTRAINT "campaign_command_requests_response_object_check"
    CHECK (jsonb_typeof("response_body") = 'object')
);
--> statement-breakpoint

CREATE UNIQUE INDEX "idx_pc_campaign_command_actor_operation_key"
  ON "public_core"."campaign_command_requests" USING btree ("actor_id", "operation", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "idx_pc_campaign_command_resource"
  ON "public_core"."campaign_command_requests" USING btree ("resource_id", "created_at");
--> statement-breakpoint

CREATE TABLE "public_core"."campaign_coverage_heads" (
  "campaign_id" uuid PRIMARY KEY NOT NULL,
  "agency" "public_core"."agency" NOT NULL,
  "coverage_version" integer NOT NULL,
  "coverage_hash" varchar(64) NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_coverage_heads_campaign_agency_fk"
    FOREIGN KEY ("campaign_id", "agency")
    REFERENCES "public_core"."recruitment_campaigns" ("id", "agency")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "campaign_coverage_heads_version_check"
    CHECK ("coverage_version" >= 0),
  CONSTRAINT "campaign_coverage_heads_hash_check"
    CHECK ("coverage_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint

CREATE TABLE "public_core"."session_command_requests" (
  "command_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL,
  "agency" "public_core"."agency" NOT NULL,
  "actor_id" uuid NOT NULL,
  "operation" varchar(48) NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "response_status" integer NOT NULL,
  "response_body" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "session_command_requests_campaign_agency_fk"
    FOREIGN KEY ("campaign_id", "agency")
    REFERENCES "public_core"."recruitment_campaigns" ("id", "agency")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "session_command_requests_hash_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "session_command_requests_response_status_check"
    CHECK ("response_status" BETWEEN 200 AND 299),
  CONSTRAINT "session_command_requests_response_object_check"
    CHECK (jsonb_typeof("response_body") = 'object')
);
--> statement-breakpoint

CREATE UNIQUE INDEX "idx_pc_session_command_actor_operation_key"
  ON "public_core"."session_command_requests" USING btree ("actor_id", "operation", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "idx_pc_session_command_campaign"
  ON "public_core"."session_command_requests" USING btree ("campaign_id", "created_at");
