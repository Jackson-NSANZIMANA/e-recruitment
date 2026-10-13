-- BUILD-001 follow-up: mirror the capacity decision constraint in Drizzle and
-- preserve completion for pre-control-plane campaigns that stopped at
-- EXAMINATION_ACTIVE. The lifecycle function/trigger further restrict this edge
-- to the deterministic LEGACY-<32 hex> code assigned by migration 0002.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaign_capacity_decision_code_check'
      AND conrelid = 'public_core.campaign_venue_assignments'::regclass
  ) THEN
    ALTER TABLE public_core.campaign_venue_assignments
      ADD CONSTRAINT campaign_capacity_decision_code_check
      CHECK (
        (capacity_decision_code IS NULL OR capacity_decision_code = 'UNBOUNDED_CAPACITY')
        AND (capacity_limit IS NULL OR capacity_decision_code IS NULL)
      );
  END IF;

  ALTER TABLE public_core.campaign_lifecycle_history
    DROP CONSTRAINT IF EXISTS campaign_lifecycle_history_legal_edge_check;
  ALTER TABLE public_core.campaign_lifecycle_history
    ADD CONSTRAINT campaign_lifecycle_history_legal_edge_check
    CHECK (
      (from_status IS NULL AND to_status = 'DRAFT') OR
      (from_status IS NOT NULL AND from_status = 'DRAFT' AND to_status IN ('REGISTRATION_OPEN', 'CANCELLED')) OR
      (from_status IS NOT NULL AND from_status = 'REGISTRATION_OPEN' AND to_status IN ('REGISTRATION_CLOSED', 'CANCELLED')) OR
      (from_status IS NOT NULL AND from_status = 'REGISTRATION_CLOSED' AND to_status = 'COMPLETED') OR
      (from_status IS NOT NULL AND from_status = 'EXAMINATION_ACTIVE' AND to_status = 'COMPLETED')
    );
END$$;

COMMIT;
