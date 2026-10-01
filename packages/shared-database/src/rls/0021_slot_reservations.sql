-- ══════════════════════════════════════════════════════════════════
-- 0021 — Slot reservation ledger + enforced venue capacity (ADR-026)
--
-- TWO DEFECTS, both silent:
--
--   1. scheduling-service was stateless. It could not tell a redelivered
--      APPLICATION_ELIGIBILITY_CLEARED from a new one, and ADR-025 made that
--      event at-least-once on purpose. Every repeat minted a NEW ticket and a
--      NEW signed QR. The slot projection keeps the FIRST ticket (NO_CHANGE),
--      but notification-service SMSes EVERY SLOT_ASSIGNED, so the citizen
--      could be holding an invitation the field tablet refuses on exam day
--      (wave 1 binds scores to the row's ticket: TICKET_MISMATCH).
--
--   2. capacity_limit / registered_count have existed on
--      campaign_venue_assignments since the genesis migration and nothing
--      ever read or wrote them. Every venue was unbounded.
--
-- THE FIX: one reservation row per application, written in the SAME
-- transaction that advances the venue's seat counter and stages SLOT_ASSIGNED
-- in the outbox. The row keeps the announced event verbatim, so a redelivery
-- re-announces the SAME eventId, ticket and signed token instead of minting.
--
-- No FK to campaign_venue_assignments or the ops applications on purpose:
-- the reservation is the record that an invitation WAS issued and must
-- outlive reference-data churn (venues are deactivated with is_active, not
-- deleted), and applications live in three agency schemas.
--
-- The writer is append-only (SELECT + INSERT). A seat release on withdrawal
-- is a deliberate follow-up with its own column and grant, not an UPDATE
-- smuggled in here.
--
-- Mirrored in schemas/slot-reservations.schema.ts. CHECKs are not modelled
-- there (schema-evolution.md).
--
-- Run as usrp_admin AFTER db:migrate and 0001/0008/0020. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public_core.slot_reservations (
  application_id      uuid               PRIMARY KEY,
  agency              public_core.agency NOT NULL,
  campaign_id         uuid               NOT NULL,
  venue_assignment_id uuid               NOT NULL,
  slot_event_id       uuid               NOT NULL,
  slot_event          jsonb              NOT NULL,
  reserved_at         timestamptz        NOT NULL DEFAULT now(),
  CONSTRAINT slot_reservations_slot_event_id_unique UNIQUE (slot_event_id)
);

-- Seat reconciliation per venue, and per-campaign reporting.
CREATE INDEX IF NOT EXISTS idx_pc_slot_reservations_venue
  ON public_core.slot_reservations (venue_assignment_id);
CREATE INDEX IF NOT EXISTS idx_pc_slot_reservations_campaign
  ON public_core.slot_reservations (campaign_id);

-- Append-only for the writer. The REVOKE strips anything a broad grant may
-- have handed this role (idempotent; revoking an absent privilege is a no-op).
GRANT SELECT, INSERT ON public_core.slot_reservations TO usrp_system_service;
REVOKE UPDATE, DELETE, TRUNCATE ON public_core.slot_reservations FROM usrp_system_service;

ALTER TABLE public_core.slot_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.slot_reservations FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_slot_reservations_system ON public_core.slot_reservations;
CREATE POLICY pc_slot_reservations_system ON public_core.slot_reservations
  TO usrp_system_service USING (true) WITH CHECK (true);

-- ── The seat counter ──────────────────────────────────────────────────────────
-- A COLUMN grant: scheduling may advance registered_count and nothing else on
-- the venue map (0008 stays read-only for every other column). The conditional
-- UPDATE that advances it also takes the venue row lock, which is what
-- serialises concurrent reservations for one venue.
GRANT UPDATE (registered_count) ON public_core.campaign_venue_assignments TO usrp_system_service;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaign_venue_assignments_registered_count_check'
      AND conrelid = 'public_core.campaign_venue_assignments'::regclass
  ) THEN
    ALTER TABLE public_core.campaign_venue_assignments
      ADD CONSTRAINT campaign_venue_assignments_registered_count_check
      CHECK (registered_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaign_venue_assignments_capacity_limit_check'
      AND conrelid = 'public_core.campaign_venue_assignments'::regclass
  ) THEN
    -- NULL keeps meaning "unbounded" (every existing seed). Zero is not a
    -- capacity, it is a closed venue: use is_active = false for that.
    ALTER TABLE public_core.campaign_venue_assignments
      ADD CONSTRAINT campaign_venue_assignments_capacity_limit_check
      CHECK (capacity_limit IS NULL OR capacity_limit > 0);
  END IF;
END$$;

COMMIT;
