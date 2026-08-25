-- Make the effects of one processing run survive being delivered twice.
--
-- The AI worker consumes `meeting_uploaded` from Kafka. That delivery is
-- at-least-once and is about to become honestly so: the worker currently
-- auto-commits its offset seconds after receiving a message, which silently
-- loses any meeting whose worker crashed mid-transcription. Moving to manual
-- commit fixes the loss and, in exchange, makes redelivery real -- so the two
-- effects that were not idempotent have to become so first.
--
-- WHAT WAS NOT IDEMPOTENT
--
--   1. AI minutes. `CallbackService.applyResult` did
--        usage.addAiMinutes(userId, round(durationSeconds / 60))
--      unconditionally, and `addAiMinutes` is a read-modify-write accumulator.
--      A duplicate result callback charged a second time against a 100-minute
--      lifetime allowance, invisibly and irreversibly.
--
--   2. Notifications. `summaryReady`, `transcriptReady` and `processingStarted`
--      passed a null `dedupe_key`, so the unique index added in V34 --
--      (user_id, kind, dedupe_key) WHERE dedupe_key IS NOT NULL -- did not
--      apply to them and a duplicate produced a second bell row.
--
-- WHY NOT KEY ON meeting_id ALONE
--
-- Because reprocessing is legitimate and is *supposed* to charge again. Today
-- `POST /meetings/{id}/reprocess` sets the meeting back to QUEUED and enqueues
-- a second `meeting_uploaded`; when that run completes, `applyResult` charges
-- for it. A meeting-scoped key would silently make every reprocess free, which
-- is a quota hole rather than a fix.
--
-- So the identity is the processing *attempt*: `meetings.processing_attempt`,
-- incremented by reprocess. A redelivery of one attempt carries the same
-- number and is refused; a genuine reprocess is a new number and is charged.
-- The worker does not have to know about it -- Spring reads the attempt from
-- the meeting row when the callback lands, so no callback contract changes.

ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS processing_attempt INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN meetings.processing_attempt IS
    'Which processing run this meeting is on. 1 at creation, incremented by reprocess. '
    'Scopes the idempotency of the effects a completed run has: see meeting_usage_charges '
    'and the notification dedupe keys.';

-- The ledger of what has actually been charged.
--
-- A row here IS the charge. `CallbackService` inserts with ON CONFLICT DO
-- NOTHING and only adds minutes when the insert reports a row -- so the
-- primary key, not a read-then-write in Java, is what makes this safe. Two
-- duplicate callbacks arriving at the same instant both attempt the insert;
-- the second is refused by the index and adds nothing.
--
-- Kept rather than derived so the charge is auditable: "why does this account
-- show 40 minutes" is answerable per meeting and per attempt.
CREATE TABLE IF NOT EXISTS meeting_usage_charges (
    meeting_id TEXT        NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    attempt    INTEGER     NOT NULL,
    user_id    TEXT        NOT NULL,
    minutes    INTEGER     NOT NULL,
    charged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, attempt)
);

COMMENT ON TABLE meeting_usage_charges IS
    'One row per processing attempt that has been billed to an account''s AI minutes. '
    'The primary key is the idempotency guard: a duplicate result callback for the same '
    'attempt loses the insert and charges nothing.';

CREATE INDEX IF NOT EXISTS idx_usage_charges_user ON meeting_usage_charges(user_id);

-- Written only by the result callback, which runs in system context. No
-- permissive policy at all, exactly like the drain half of outbox_events:
-- with RLS enabled and no policy, every command matches nothing for
-- recallix_app, and recallix_sys bypasses policies entirely.
ALTER TABLE meeting_usage_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_usage_charges FORCE ROW LEVEL SECURITY;

-- Backfill: every meeting that already reached READY was charged once under the
-- old unconditional code. Recording that as attempt 1 stops a redelivery of an
-- in-flight message double-charging a meeting that completed before this
-- migration ran.
INSERT INTO meeting_usage_charges (meeting_id, attempt, user_id, minutes)
SELECT m.id, 1, m.user_id, GREATEST(0, ROUND(m.duration_seconds / 60.0)::int)
  FROM meetings m
 WHERE m.status = 'READY'
   AND m.duration_seconds IS NOT NULL
   AND m.duration_seconds > 0
ON CONFLICT DO NOTHING;
