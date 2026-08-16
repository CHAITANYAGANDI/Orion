-- A record of what Recallix did, so the product stops being silent between
-- clicks.
--
-- Everything below already happened. A meeting was transcribed, a summary was
-- written, a recap went out, a task fell overdue, somebody opened a link you
-- shared. Today none of it is visible unless you happen to be looking at the
-- page it happened on: the meeting page has a live status socket, and that is
-- the entire feedback surface. Close the tab and the product has nothing to say
-- about the twenty minutes it spent working for you.
--
-- WHY A TABLE AND NOT JUST THE SOCKET
--   A socket tells you what is happening while you watch. The interesting case
--   is the opposite one — you uploaded an hour of audio and went to lunch — and
--   an event nobody was connected for has to have been written down somewhere or
--   it never happened. This is also what makes an unread count possible, which
--   is the only part of a notification system anybody actually looks at.
--
-- WHY read_at IS A TIMESTAMP AND NOT A BOOLEAN
--   "When did you see this" answers questions a boolean cannot: whether a
--   digest arrived before or after somebody acted, and how long an overdue task
--   sat unlooked-at. It costs the same eight bytes either way.
--
-- DEDUPLICATION
--   Two of these repeat on a schedule and one repeats on traffic. A task that is
--   overdue is overdue again tomorrow, and a link that gets shared with forty
--   people is opened forty times. Without a key, the bell becomes a firehose and
--   the feature is uninstalled by the user simply not clicking it any more. So a
--   notification may carry a `dedupe_key` — typically "subject:day" — and a
--   second insert with the same key is a no-op rather than a duplicate.
--
-- WHAT IS NOT HERE, AND WHY
--   Recallix has one account per workspace: no teams, no members, no invitations.
--   So "someone commented" has no counterpart at all — action item notes are a
--   private working log, and notifying you about your own note is a product
--   telling you what you just did. The two neighbouring ideas do exist, aimed at
--   the real events a single-account product has: MENTIONED_IN_MEETING (a
--   meeting assigned work to you by name) and SHARE_VIEWED (a link you published
--   was opened by somebody outside). Both are in `domain/NotificationKind`, and
--   the day Recallix grows accounts, the mention kind is already the right shape.

CREATE TABLE IF NOT EXISTS notifications (
    id      TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- domain/NotificationKind. Text rather than an enum type so adding a kind is
    -- a code change and not a migration plus a deploy ordering problem.
    kind TEXT NOT NULL,

    -- Written when the notification is created, never rendered from a template
    -- at read time. A notification is a record of a moment: if a meeting is
    -- renamed afterwards, "Sprint planning is ready" was still what happened,
    -- and re-deriving it would quietly rewrite history.
    title TEXT NOT NULL,
    body  TEXT,

    -- What it is about. Both nullable, both ON DELETE CASCADE: a notification
    -- about a deleted meeting is a dead link, and a dead link in a list of
    -- fifteen is worse than an absence.
    meeting_id     TEXT REFERENCES meetings (id) ON DELETE CASCADE,
    action_item_id TEXT REFERENCES meeting_action_items (id) ON DELETE CASCADE,

    -- Where clicking it goes, relative to the app root. Stored rather than
    -- derived for the same reason as the title: the route that was right when
    -- this happened is the one that was meant.
    link TEXT,

    read_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- See DEDUPLICATION above. Null means "this one is always worth saying".
    dedupe_key TEXT,

    CONSTRAINT ck_notifications_title CHECK (length(btrim(title)) BETWEEN 1 AND 300)
);

-- The list, newest first, which is the only way it is ever read.
CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications (user_id, created_at DESC);

-- The badge. Partial, because unread is a small and shrinking subset of a table
-- that only grows, and counting it is the most frequent query here by far.
CREATE INDEX IF NOT EXISTS idx_notifications_unread
    ON notifications (user_id)
    WHERE read_at IS NULL;

-- Enforced in the database rather than by a read-then-write in the service:
-- the reminder job and forty simultaneous share views are exactly the races a
-- check-first would lose.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe
    ON notifications (user_id, kind, dedupe_key)
    WHERE dedupe_key IS NOT NULL;

-- --------------------------------------------------------------------------
-- Muting
-- --------------------------------------------------------------------------
-- A list of what is switched off rather than a list of what is on, so that
-- everything is on by default and adding a kind later needs no migration and
-- no backfill. These cost nothing to deliver — they are a row and a socket
-- frame, not an email — so the sane default is all of them.
--
-- JSONB rather than TEXT[] only because that is what every other list in this
-- schema is (`meetings.tags`, `meeting_summaries.key_points`), and one column
-- mapped differently from all of them is a trap for whoever writes the next
-- entity by copying a neighbour.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS muted_notifications JSONB NOT NULL DEFAULT '[]'::jsonb;

-- --------------------------------------------------------------------------
-- Row-Level Security (see V9)
-- --------------------------------------------------------------------------
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notifications;
CREATE POLICY tenant_isolation ON notifications
    FOR ALL
    USING (user_id = app_current_user())
    WITH CHECK (user_id = app_current_user());

COMMENT ON TABLE notifications IS
    'What Recallix did while you were not looking. One account per workspace, so every row is about your own work.';
COMMENT ON COLUMN notifications.dedupe_key IS
    'Suppresses repeats of the recurring kinds — typically subject:day. Null means always insert.';
COMMENT ON COLUMN users.muted_notifications IS
    'Kinds switched off. Absent means on, so a new kind ships enabled.';
