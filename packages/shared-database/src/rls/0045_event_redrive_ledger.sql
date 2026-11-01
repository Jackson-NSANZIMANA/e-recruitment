-- ══════════════════════════════════════════════════════════════════
-- 0045 — Durable event re-drive ledger · D0 (Phase 0), ADR-050
--
-- THE DEFECT THIS CLOSES (evaluation 2026-10-29, D2). ADR-025 parked what a
-- handler could not process on `events.dead-letter`, which stopped one poison
-- message holding a partition hostage. Nothing then ever picked it up: the
-- in-process retry budget is six attempts in ~15.5 s (a window, not a schedule),
-- and the operator replay tool is stateless — no per-letter record, no backoff,
-- no cap, so running it after an outage re-publishes letters that already
-- succeeded. The event was durable; its STATE was not. A clearance whose Irembo
-- lookup met a 429 sat at CRIMINAL_CLEARANCE with a checklist saying "we are
-- verifying" — for eleven days.
--
-- A KAFKA OFFSET IS A CURSOR; IT CANNOT SCHEDULE. This table is the schedule.
-- It is the same durable-claim idiom the platform already uses for stalled
-- clearances and slot reservations: one row per letter, advanced by a worker,
-- read back after a restart.
--
-- UNIQUE (topic, partition, offset, group) is the load-bearing constraint: a
-- restart, a second instance, or two workers racing all converge on ONE row per
-- letter, so a re-drive can never be counted twice.
--
-- No payload is stored. The bytes stay on `events.dead-letter`, which is what
-- the worker re-publishes from; this table only decides WHEN and WHETHER.
--
-- Number: 0045 (renumbered from 0043 at rebase onto rls/0043-0044), reserved for ADR-050 in the programme README. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public_core.event_redrive_ledger (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_topic              varchar(128) NOT NULL,
  source_partition          integer NOT NULL CHECK (source_partition >= 0),
  source_offset             bigint NOT NULL CHECK (source_offset >= 0),
  group_id                  varchar(128) NOT NULL,
  -- The event's own id (x-usrp-dlq-event-id). A re-driven event that fails again is
  -- dead-lettered at a NEW offset; this is what lets the new row INHERIT the
  -- attempts already spent, so the cap actually terminates. Nullable: a letter
  -- whose event id could not be read is treated as a fresh chain.
  event_id                  varchar(64),
  -- The dead-letter reason the letter arrived with (ADR-025 vocabulary).
  reason                    varchar(24) NOT NULL,
  -- Completed re-drives. 0 = never attempted.
  attempts                  integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consecutive_group_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_group_failures >= 0),
  -- RETRYING (on the schedule) | REDRIVEN (republished; job done) | PARKED
  -- (given up, with a closed reason). Rows are never deleted: the ledger is the
  -- evidence that the platform tried.
  state                     varchar(16) NOT NULL DEFAULT 'RETRYING'
                              CHECK (state IN ('RETRYING', 'REDRIVEN', 'PARKED')),
  first_seen_at             timestamptz NOT NULL DEFAULT now(),
  last_attempt_at           timestamptz,
  next_attempt_at           timestamptz NOT NULL DEFAULT now(),
  -- Closed codes only: an alerting rule keys on these, never on prose.
  last_error_code           varchar(48),
  parked_reason             varchar(32)
                              CHECK (parked_reason IS NULL OR parked_reason IN
                                ('ATTEMPTS_EXHAUSTED', 'NON_RETRYABLE', 'UNDECODABLE', 'REPEATED_FAILURE')),
  parked_at                 timestamptz,
  CONSTRAINT uq_event_redrive_letter
    UNIQUE (source_topic, source_partition, source_offset, group_id),
  -- A parked row must say why; a retrying or re-driven row must not.
  CONSTRAINT ck_event_redrive_parked
    CHECK ((state = 'PARKED') = (parked_reason IS NOT NULL AND parked_at IS NOT NULL))
);

-- The worker's only query: "what is due, oldest first". Partial, because the
-- parked rows are never selected and accumulate forever.
CREATE INDEX IF NOT EXISTS idx_event_redrive_due
  ON public_core.event_redrive_ledger (next_attempt_at)
  WHERE state = 'RETRYING';

-- Chain lookup at intake: "have we already spent attempts on this event?"
CREATE INDEX IF NOT EXISTS idx_event_redrive_chain
  ON public_core.event_redrive_ledger (group_id, event_id) WHERE event_id IS NOT NULL;

-- The intake cursor: how far into each dead-letter partition the worker has
-- REGISTERED letters. Without it nothing ever creates a ledger row.
CREATE TABLE IF NOT EXISTS public_core.event_redrive_cursor (
  topic        varchar(128) NOT NULL,
  partition    integer NOT NULL CHECK (partition >= 0),
  next_offset  bigint NOT NULL CHECK (next_offset >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic, partition)
);

-- The circuit breaker's read: consecutive failures per (group, topic).
CREATE INDEX IF NOT EXISTS idx_event_redrive_group
  ON public_core.event_redrive_ledger (group_id, source_topic, state);

-- The platform's system role owns the worker. No officer role can see this
-- table at all: it is operational state, not case data.
GRANT SELECT, INSERT, UPDATE ON public_core.event_redrive_ledger TO usrp_system_service;
GRANT SELECT, INSERT, UPDATE ON public_core.event_redrive_cursor TO usrp_system_service;

-- FORCE'd RLS like every other system-owned store (rls/0020). The policy is
-- trivial today — one system role, one concern — but it means a future role
-- cannot read the platform's failure state without a deliberate policy change.
ALTER TABLE public_core.event_redrive_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.event_redrive_ledger FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_event_redrive_system ON public_core.event_redrive_ledger;
CREATE POLICY pc_event_redrive_system ON public_core.event_redrive_ledger
  FOR ALL TO usrp_system_service USING (true) WITH CHECK (true);

ALTER TABLE public_core.event_redrive_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.event_redrive_cursor FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pc_event_redrive_cursor_system ON public_core.event_redrive_cursor;
CREATE POLICY pc_event_redrive_cursor_system ON public_core.event_redrive_cursor
  FOR ALL TO usrp_system_service USING (true) WITH CHECK (true);

COMMIT;
