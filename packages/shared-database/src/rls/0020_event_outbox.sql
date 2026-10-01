-- ══════════════════════════════════════════════════════════════════
-- 0020 — Transactional event outbox (ADR-025)
--
-- THE DEFECT: every producer did `COMMIT state; then bus.publish(event)`.
-- Two writes, two systems, no atomicity. If the process died or Kafka refused
-- between them, the state was recorded and the event was lost. Worse, the
-- projections are idempotent, so the redelivered trigger returns NO_CHANGE and
-- the lost event is NEVER re-emitted: an application can reach
-- DOCUMENT_REVIEW_GREEN and never be scheduled, silently, forever.
--
-- THE FIX: the event row is INSERTed in the same transaction as the state
-- change. Either both commit or neither does. A relay then publishes pending
-- rows in id order and stamps published_at. Delivery is at-least-once (a crash
-- between publish and stamp republishes); consumers are idempotent by
-- contract, which is the half of the bargain they already keep.
--
-- Shape notes:
--   • producer scopes a row to the service that wrote it, so each service's
--     relay drains only its own rows and one cannot stall another;
--   • event_id is UNIQUE: the same envelope can never be staged twice;
--   • the pending partial index keeps the relay's scan proportional to the
--     backlog, not to history;
--   • published rows are purged by the relay after a retention window.
--     Payloads mirror what Kafka already carries (opaque ids, keyed hashes,
--     never a raw National ID), so the outbox widens no PII surface.
--
-- usrp_system_service only, under FORCE'd RLS, like every other system-owned
-- store. Mirrored in schemas/event-outbox.schema.ts.
--
-- Run as usrp_admin AFTER db:migrate and 0001. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public_core.event_outbox (
  id           bigserial     PRIMARY KEY,
  event_id     uuid          NOT NULL,
  event_type   varchar(64)   NOT NULL,
  producer     varchar(64)   NOT NULL,
  payload      jsonb         NOT NULL,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts     integer       NOT NULL DEFAULT 0,
  last_error   varchar(512),
  CONSTRAINT event_outbox_event_id_unique UNIQUE (event_id)
);

-- The relay's working set: this producer's unpublished rows, in id order.
CREATE INDEX IF NOT EXISTS idx_pc_event_outbox_pending
  ON public_core.event_outbox (producer, id)
  WHERE published_at IS NULL;

-- Retention purge of delivered rows.
CREATE INDEX IF NOT EXISTS idx_pc_event_outbox_published
  ON public_core.event_outbox (published_at)
  WHERE published_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public_core.event_outbox TO usrp_system_service;
GRANT USAGE, SELECT ON SEQUENCE public_core.event_outbox_id_seq TO usrp_system_service;

ALTER TABLE public_core.event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.event_outbox FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_event_outbox_system ON public_core.event_outbox;
CREATE POLICY pc_event_outbox_system ON public_core.event_outbox
  TO usrp_system_service USING (true) WITH CHECK (true);

COMMIT;
