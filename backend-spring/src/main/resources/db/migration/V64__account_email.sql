-- Mail comes back, for seven messages, and it comes back durable.
--
-- WHY THIS IS NOT A REVERT OF V56
--   V56 was right about what it deleted. Four messages went: a recap of every
--   meeting, a daily deadline reminder, a Monday review, and a once-a-day notice
--   about comments and highlights. Three of those reported something the reader
--   could already see by opening the app, and the fourth arrived whether or not
--   there was anything in it. Mail like that gets filtered, and once a sender is
--   filtered every later message is filtered with it -- including the one that
--   mattered.
--
--   What comes back is chosen by a different test: does the message reach
--   somebody who is NOT in Recallix, about something they cannot see from
--   outside it, in time to act? Six of the seven are irreversible or
--   time-bound. The seventh is a deadline you agreed to out loud, which is worth
--   an email precisely because you are in your calendar rather than here.
--
-- THE SEVEN, AND WHICH OF THEM HAS A SWITCH
--   Five are switchable and default to FALSE. An account that never asked for
--   mail must not start receiving it because a migration ran -- the same rule
--   V43 wrote down, and the reason it is written down twice.
--
--     retention_warning_email   7 days before retention erases something
--     retention_applied_email   the nightly retention pass erased something
--     task_reminder_email       action items due tomorrow, and overdue ones
--     notes_ready_email         a LONG recording has finished processing
--     allowance_email           ~85% of the transcription allowance is spent
--
--   Two have no switch and are not in this table at all: the allowance being
--   fully spent, and the account being closed. Both are terminal facts about the
--   account rather than notifications about its contents. The second is the
--   sharper case: closing an account deletes the user row, so there is no switch
--   left to read and no bell left to ring -- mail is the only channel that still
--   exists, it is the only record the person keeps, and it is the only way they
--   would learn of it if it was not them.
--
-- =========================================================================
-- WHY THERE ARE NO *_emailed_on STAMPS HERE
-- =========================================================================
--   An earlier draft of this migration had five, in the shape V43 used: a date
--   column per message, written after a successful send. That shape is
--   at-MOST-once, and every message here reports something irreversible.
--
--   Concretely: the retention pass deletes a night's meetings, tries to send,
--   Resend is unreachable for ninety seconds, the stamp is not written -- and
--   the message is gone for good, because tomorrow's pass computes tomorrow's
--   deletions and nothing ever mentions tonight's again. The account holder
--   lost data and was never told. The stamp did its job perfectly.
--
--   So the stamp is replaced by a row in `mail_outbox`, written in the SAME
--   transaction as the irreversible act. Committing the deletion and committing
--   the intent to send are then one event: either both happened or neither did.
--   Delivery becomes a separate, retried concern.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS retention_warning_email BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS retention_applied_email BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS task_reminder_email     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS notes_ready_email       BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS allowance_email         BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.retention_warning_email IS
    'Mail before the retention policy erases something. One warning per impending deletion date; see mail_outbox.dedupe_key.';
COMMENT ON COLUMN users.retention_applied_email IS
    'Mail when the nightly pass erased something. One per night''s work, never one per meeting.';
COMMENT ON COLUMN users.task_reminder_email IS
    'Daily digest of action items due tomorrow and already overdue. Suppressed entirely when the list is empty.';
COMMENT ON COLUMN users.notes_ready_email IS
    'Mail when a LONG recording finishes processing. Short ones finish before the tab is closed and are never mailed.';
COMMENT ON COLUMN users.allowance_email IS
    'Mail once when the transcription allowance is nearly spent. Being fully spent is sent regardless -- it has no switch.';

-- =========================================================================
-- The mail outbox
-- =========================================================================
--
-- SAME PATTERN AS outbox_events, DIFFERENT TRANSPORT
--   `outbox_events` already proves this shape works here: enqueue in the
--   business transaction, drain from a scheduled relay with FOR UPDATE SKIP
--   LOCKED, back off on failure, retire what can never succeed. This is a
--   second table rather than a second topic on that one because the transport
--   is different in kind -- that relay speaks to Kafka and only to Kafka, its
--   rows carry a topic and a partition key and a jsonb payload, and its
--   per-key FIFO ordering is a guarantee mail neither needs nor wants. Adding
--   a "send an email" topic would put two transports behind one publisher and
--   make the retry policy of each the other's problem.
--
-- WHY EVERY FIELD NEEDED FOR DELIVERY IS COPIED IN
--   There is no user_id foreign key and no join at send time. The account-closed
--   message is the reason and the proof: by the time it is sent the user row is
--   gone, along with the address, the meeting count and the switches. A row
--   that had to look any of that up would be a row that could never be sent.
--
--   So `to_address`, `subject`, `body_text` and `body_html` are captured at
--   enqueue and are immutable afterwards. `user_id` is kept for support and
--   purging and is deliberately a plain TEXT column: no REFERENCES, no CASCADE.
--   A cascade here would delete the evidence of the deletion.
--
-- dedupe_key IS THE WHOLE IDEMPOTENCY STORY
--   UNIQUE, and every enqueue is ON CONFLICT DO NOTHING. That makes enqueueing
--   idempotent rather than merely careful, which is what lets two scheduler
--   instances tick at the same second, or one instance tick twice after a
--   restart, without producing two messages.
--
--   It is also sent to the provider as an idempotency key on every attempt, so
--   the one case the database cannot cover -- the send succeeded and the
--   process died before it could be marked -- is deduplicated at Resend rather
--   than arriving twice.
--
--   The keys are deterministic, never random:
--     retention-warning:{user}:{the date the deletion will happen}
--     retention-applied:{user}:{date}
--     task-reminder:{user}:{date}
--     notes-ready:{meeting}
--     allowance-low:{user}
--     allowance-spent:{user}
--     account-closed:{user}
--
--   Note the first one. Keying it to the DATE THE DELETION LANDS, rather than
--   to the day the warning was sent, is what lets two different batches falling
--   a day apart each get their own warning while neither is ever warned twice.
--   A "one warning a week" stamp cannot do that: it suppresses the second batch
--   for six days, by which time it has been deleted.

CREATE TABLE IF NOT EXISTS mail_outbox (
    id              TEXT PRIMARY KEY,
    dedupe_key      TEXT        NOT NULL UNIQUE,
    -- Denormalised on purpose. See above: no FK, no join, no lookup.
    to_address      TEXT        NOT NULL,
    subject         TEXT        NOT NULL,
    body_text       TEXT        NOT NULL,
    body_html       TEXT        NOT NULL,
    -- Whose it was. Informational; no REFERENCES, no CASCADE.
    user_id         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Delivered. The terminal success state; nothing claims it again.
    sent_at         TIMESTAMPTZ,
    -- Abandoned. The terminal failure state, kept with its error to be read.
    abandoned_at    TIMESTAMPTZ,
    attempt_count   INTEGER     NOT NULL DEFAULT 0,
    -- Durable backoff, for the same reason outbox_events has one: an in-memory
    -- schedule is reset by every restart and disagreed about by every instance.
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Past this, delivering it would be worse than not delivering it. Set at
    -- enqueue, per message kind; see MailLifetime.
    expires_at      TIMESTAMPTZ,
    -- Sanitised before it is written. See MailDispatcher and Mailer.
    last_error      TEXT
);

-- The relay's only query. Partial, so the index is the size of the backlog
-- rather than of every message ever sent -- and so a delivered row costs
-- nothing to skip.
CREATE INDEX IF NOT EXISTS idx_mail_outbox_pending
    ON mail_outbox (next_attempt_at, created_at, id)
 WHERE sent_at IS NULL AND abandoned_at IS NULL;

-- For the purge, which only ever looks at delivered rows.
CREATE INDEX IF NOT EXISTS idx_mail_outbox_sent
    ON mail_outbox (sent_at)
 WHERE sent_at IS NOT NULL;

COMMENT ON TABLE mail_outbox IS
    'Transactional outbox for email. A row is committed with the irreversible act it reports, so a provider outage delays a message instead of losing it.';
COMMENT ON COLUMN mail_outbox.dedupe_key IS
    'Deterministic. UNIQUE so enqueueing twice is a no-op, and sent to the provider as an idempotency key so a retry after a lost acknowledgement does not arrive twice.';
COMMENT ON COLUMN mail_outbox.to_address IS
    'Captured at enqueue. The account-closed message is sent after the row holding the address has been deleted.';
COMMENT ON COLUMN mail_outbox.user_id IS
    'Informational only, and deliberately not a foreign key: a cascade here would delete the record of the deletion.';
COMMENT ON COLUMN mail_outbox.abandoned_at IS
    'Set when delivery is given up on. Never claimed again; the row is kept with its error.';


-- =========================================================================
-- Lifecycle: how long a row lives, in each of its three states
-- =========================================================================
--
-- This table has no foreign key to `users` and it must not have one -- the
-- account-closure message is sent after the row it would reference is gone.
-- The cost of that is exactly what it sounds like: an address, a subject and a
-- body survive `PrivacyService.closeAccount`, which has otherwise erased
-- everything about the account. So the lifetime is written down rather than
-- left to "forever", and it is short.
--
--   PENDING / RETRYING
--     Kept while delivery is still possible and still useful. Two bounds, and
--     they are different things:
--       * `next_attempt_at` and the twelve-attempt ceiling bound the RETRYING,
--         and are sized to the provider's idempotency window (see MailDispatcher).
--       * `expires_at` bounds the USEFULNESS, and is per message kind. A daily
--         digest that missed its day is not worth sending; a notice that an
--         account was destroyed is worth sending late. See MailLifetime.
--     An expired row is moved to the abandoned state rather than deleted, so
--     "this was never sent, and why" stays answerable.
--
--   SENT
--     Seven days. It is a delivery receipt and nothing else -- the message has
--     arrived, the person has it, and the copy here is now only personal data
--     with an operational half-life. A week is enough to answer "did that go
--     out on Tuesday" and short enough that a closed account's address is not
--     sitting in a table a month later.
--
--   ABANDONED
--     Thirty days. Longer than SENT, which looks backwards for a privacy
--     lifetime and is the deliberate choice: an abandoned row is the record
--     that somebody was NOT told something, and for the account-closure and
--     allowance-spent messages that is the only trace that the notice failed.
--     A week is not long enough for anyone to notice, ask, and look. A month is.
--
-- Both purges are bounded-batch deletes run by the relay in system context,
-- with the same multi-instance safety as everything else here: the statement is
-- `DELETE ... WHERE id IN (SELECT ... LIMIT n)`, so two relays purging at once
-- delete disjoint sets and neither holds a long lock.

CREATE INDEX IF NOT EXISTS idx_mail_outbox_expiring
    ON mail_outbox (expires_at)
 WHERE sent_at IS NULL AND abandoned_at IS NULL AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mail_outbox_abandoned
    ON mail_outbox (abandoned_at)
 WHERE abandoned_at IS NOT NULL;

COMMENT ON COLUMN mail_outbox.expires_at IS
    'When delivering this would be worse than not delivering it. Per message kind; a digest expires with its day, a security notice does not.';
COMMENT ON COLUMN mail_outbox.last_error IS
    'Sanitised before storage: status and reason only, with anything token-shaped removed. This column is long-lived and a provider body is not trusted to be free of credentials.';

-- ---------------------------------------------------------------------------
-- Row-level security: the same split outbox_events settled on in V10 and V11.
-- ---------------------------------------------------------------------------
--   INSERT  any configured session. A mail row is an instruction to the relay,
--           not tenant data, and it is written by ordinary requests -- closing
--           an account enqueues one inside the transaction that does the
--           deleting, which is the whole point. There is nothing to check it
--           against: `user_id` is informational, and for the account-closed
--           message the row it would name no longer exists.
--
--   SELECT / UPDATE / DELETE  no policy at all, so with RLS enabled these match
--           nothing for the unprivileged role. The relay connects as the system
--           role, which holds BYPASSRLS. Draining is its job, and a bug in a
--           request handler cannot read other tenants' addresses out of it.
ALTER TABLE mail_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mail_enqueue ON mail_outbox;
CREATE POLICY mail_enqueue ON mail_outbox
    FOR INSERT
    WITH CHECK (app_current_user() IS NOT NULL);
