-- Durable retry state for the outbox, and a terminal state for events that can
-- never be published.
--
-- WHAT WAS MISSING
--
-- Phase 2 gave each relay exclusive ownership of the rows it claims, and made
-- the head of one meeting's queue block only that meeting rather than the whole
-- backlog. What it did not give was any memory of failure. A row that could not
-- be published was simply left alone, so the next tick -- one second later --
-- claimed it again, failed again and logged again, forever. Two consequences:
--
--   1. An unreachable broker produced one WARN per second per instance, which
--      is the shape of a log that nobody reads.
--
--   2. A single event that can NEVER be published -- a payload larger than the
--      broker will accept, say -- sat at the head of its meeting's queue and
--      blocked every later event for that meeting permanently. Per-key rather
--      than global, but still forever.
--
-- WHAT THESE COLUMNS ARE FOR
--
--   attempt_count    how many times publication has been tried and failed. The
--                    input to the backoff, and the number an operator wants
--                    first when asked whether something is stuck.
--
--   next_attempt_at  when this row is eligible again. The relay skips rows that
--                    are not yet due, which is what turns "retry" into
--                    "backoff" -- and because it is a column rather than a
--                    timer in memory, the schedule survives a restart, a
--                    failover and a deploy, and is shared by every instance.
--
--   last_error       the most recent failure, for the person reading the row.
--
--   failed_at        the terminal mark. Non-null means publication was
--                    abandoned: the relay will never claim this row again, and
--                    -- the point of the whole exercise -- it steps out of its
--                    meeting's ordering chain so the next event can go.
--
-- There is deliberately no `last_attempt_at`. For a row still retrying it is
-- next_attempt_at minus the delay its attempt_count implies, and for a row that
-- has stopped it is failed_at; a third timestamp that can disagree with the
-- other two is a liability, not a diagnostic.
--
-- WHY published STAYS A BOOLEAN
--
-- The obvious alternative is one `status` column (PENDING/PUBLISHED/FAILED).
-- It would be tidier on a blank page, but `published` is what the claim query,
-- the partial index and every previous migration are written against, and the
-- three states are already distinguishable: published, failed_at non-null, or
-- neither. Rewriting a working state machine to spell it differently is churn.
--
-- WHY NO NEW INDEX
--
-- The claim query now filters on failed_at and next_attempt_at as well. It was
-- worth checking whether it wants an index for that, so it was measured rather
-- than guessed: against 5000 rows, EXPLAIN ANALYZE chose idx_outbox_unpublished
-- for both sides of the anti-join and produced a byte-identical plan with and
-- without a covering (topic, partition_key, created_at, id) partial index --
-- the planner simply did not use it. An index nothing reads is write cost for
-- nothing, so there is not one.

ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS attempt_count   INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS last_error      TEXT,
    ADD COLUMN IF NOT EXISTS failed_at       TIMESTAMPTZ;

-- Existing rows have never failed, so the defaults are already right for them:
-- zero attempts, due immediately, no error, not terminal. No backfill.

COMMENT ON COLUMN outbox_events.attempt_count   IS 'Failed publication attempts so far. Drives the retry backoff.';
COMMENT ON COLUMN outbox_events.next_attempt_at IS 'Not eligible for claiming before this. Survives restarts; shared by all relay instances.';
COMMENT ON COLUMN outbox_events.last_error      IS 'Most recent publication failure, for diagnosis. Never contains the payload.';
COMMENT ON COLUMN outbox_events.failed_at       IS 'Non-null: publication abandoned. Never claimed again, and no longer blocks later events for its key.';
