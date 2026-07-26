-- ══════════════════════════════════════════════════════════════════
-- 0017 — Erasure request intake (ADR-020, owner D10)
--
-- Citizen-initiated erasure is a REQUEST, not an execution: the
-- session-authenticated citizen files it here; an officer/DPO reviews
-- and either executes it through the existing gated erasure road
-- (ADR-015 — gate mechanics unchanged) or declines it with a recorded
-- ground. The irreversible tombstone-overwrite therefore stays behind
-- an accountable human, while the citizen's Law N° 058/2021 request is
-- captured, timestamped, and auditable from the moment it is made.
--
-- The row is PII-free by construction (opaque applicant UUID, status,
-- timestamps, an officer UUID and a bounded note) — like audit rows it
-- SURVIVES the erasure it asks for: proof the request existed is part
-- of the controller's accountability, not part of the subject's PII.
--
-- Consistency is a table CHECK, not app discipline: PENDING rows carry
-- no decision fields; decided rows carry both. One live PENDING request
-- per citizen (partial unique index) makes re-filing idempotent.
--
-- System-role-scoped like 0016: identity-service (usrp_system_service)
-- owns both doors — the citizen files through their session, officers
-- read/decide through officer-authenticated routes running as the
-- system role, exactly as the erasure execution itself does.
--
-- NOT mirrored in the drizzle schema files (0016 precedent): hand-run
-- rls/ DDL owns this table; keeping it out of the drizzle model keeps
-- the first real `drizzle-kit generate` (contact-capture slice) from
-- re-inventing hand-migrated tables in its diff.
--
-- Run as usrp_admin AFTER db:migrate and 0001. Fully re-runnable.
-- ══════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS public_core.erasure_requests (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid         NOT NULL REFERENCES public_core.applicant_identities(id),
  status        varchar(10)  NOT NULL DEFAULT 'PENDING',
  requested_at  timestamptz  NOT NULL DEFAULT now(),
  decided_by    uuid,                      -- officer UUID (token sub) for EXECUTED / DECLINED
  decided_at    timestamptz,
  decision_note varchar(200),              -- decline ground; NULL for EXECUTED is fine
  CONSTRAINT erasure_request_status_valid
    CHECK (status IN ('PENDING', 'EXECUTED', 'DECLINED')),
  -- All-or-nothing decision stamp: a PENDING row has no decision fields,
  -- a decided row has who and when (the note stays optional).
  CONSTRAINT erasure_request_decision_consistent
    CHECK (
      (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL)
      OR
      (status IN ('EXECUTED', 'DECLINED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    )
);

-- One live request per citizen — re-filing finds this and is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_erasure_request_pending
  ON public_core.erasure_requests (applicant_id) WHERE status = 'PENDING';

-- The DPO queue reads oldest-first; the citizen reads their own newest.
CREATE INDEX IF NOT EXISTS idx_pc_erasure_request_applicant
  ON public_core.erasure_requests (applicant_id, requested_at DESC);

GRANT SELECT, INSERT, UPDATE ON public_core.erasure_requests TO usrp_system_service;

ALTER TABLE public_core.erasure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_core.erasure_requests FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pc_er_system ON public_core.erasure_requests;
CREATE POLICY pc_er_system ON public_core.erasure_requests
  TO usrp_system_service USING (true) WITH CHECK (true);

COMMIT;
