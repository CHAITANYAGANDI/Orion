-- Two things the new home screen needs, and one of them changes an ownership
-- model, so it is worth being explicit about why.
--
-- --------------------------------------------------------------------------
-- 1. An action item that did not come from a meeting
-- --------------------------------------------------------------------------
-- Until now every action item was a fact extracted from a transcript, which is
-- why it hung off `meeting_id` and inherited its tenancy from the meeting. That
-- was right while the only way to get one was to have said it out loud.
--
-- The workspace action-item panel breaks that assumption. "Write the migration"
-- is a thing somebody types into a box on the home screen; it belongs to them,
-- not to a conversation, and there is no meeting to attach it to without
-- inventing one. Attaching it to the most recent meeting — the obvious dodge —
-- would put a task in the notes of a call it was never mentioned in, and would
-- delete it the day that call is deleted.
--
-- So the row learns who owns it directly, and `meeting_id` becomes optional.
--
-- WHY user_id RATHER THAN A SYNTHETIC "INBOX" MEETING
--   A fake meeting would show up in the meetings list, in search, in the
--   retention pass and in the export. Every one of those would need to know to
--   hide it, which is five places to forget.
--
-- WHY THE POLICY CHANGES SHAPE
--   V9 gave this table a meeting-owned policy — an EXISTS against `meetings`.
--   With a nullable `meeting_id` that predicate is false for exactly the rows
--   somebody just typed, so their own task would be invisible to them the
--   instant it was written. The direct check is also cheaper: one column
--   comparison instead of a primary-key lookup per row.
--
--   Ownership is the whole predicate, with no system escape in it. V11 removed
--   `app_is_system()` from every policy and dropped the function, because a
--   session could turn it on with one injected `set_config`. System work is
--   exempt by connecting as `recallix_sys`, which holds BYPASSRLS — a role
--   attribute no statement can grant itself.

ALTER TABLE meeting_action_items
    ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users (id) ON DELETE CASCADE;

-- Backfilled from the parent before the column is made mandatory: every
-- existing row has a meeting, and the meeting knows whose it is.
UPDATE meeting_action_items a
   SET user_id = m.user_id
  FROM meetings m
 WHERE m.id = a.meeting_id
   AND a.user_id IS NULL;

-- Any row whose meeting has already gone would fail the NOT NULL below. There
-- should be none — the foreign key cascades — but a delete that raced a
-- backfill is exactly the kind of thing that makes a migration unrepeatable.
DELETE FROM meeting_action_items WHERE user_id IS NULL;

ALTER TABLE meeting_action_items
    ALTER COLUMN user_id SET NOT NULL,
    ALTER COLUMN meeting_id DROP NOT NULL;

-- The panel's only read: everything one account owes, whatever it came from.
CREATE INDEX IF NOT EXISTS idx_action_items_user
    ON meeting_action_items (user_id);

DROP POLICY IF EXISTS tenant_isolation ON meeting_action_items;
CREATE POLICY tenant_isolation ON meeting_action_items
    FOR ALL
    USING      (user_id = app_current_user())
    WITH CHECK (user_id = app_current_user());

COMMENT ON COLUMN meeting_action_items.user_id IS
    'Who owes this. Direct rather than through the meeting, because a task typed on the home screen has no meeting.';
COMMENT ON COLUMN meeting_action_items.meeting_id IS
    'The conversation it was promised in, or NULL for one added by hand.';

-- --------------------------------------------------------------------------
-- 2. A calendar feed of deadlines
-- --------------------------------------------------------------------------
-- The one integration Recallix can honestly offer today.
--
-- WHY OUTBOUND AND NOT INBOUND
--   V8 added `calendar_subscriptions` for reading somebody's calendar, and
--   nothing ever used it — because the only thing worth doing with a list of
--   upcoming meetings is joining them to record, and Recallix has no bot. It
--   records from your own browser tab. So the inbound direction produces a list
--   you cannot act on.
--
--   The outbound direction works today and needs nothing new from anybody: your
--   action items already have resolved dates, every calendar application on
--   earth subscribes to an ICS URL, and no OAuth client, no provider review and
--   no stored third-party credential is involved.
--
-- WHY A TOKEN AND NOT THE USER ID
--   The feed is fetched by Google's servers, with no session and no header they
--   would let us add, so the URL is the credential. It therefore has to be
--   unguessable, and it has to be revocable without changing who you are —
--   which is precisely what a rotatable token is and what a user id is not.
--
--   NULL means no feed has ever been created, which is the default: an account
--   that has not asked for one should not have a live secret URL sitting on it.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS calendar_token TEXT,
    ADD COLUMN IF NOT EXISTS calendar_token_created_at TIMESTAMPTZ;

-- Looked up by token on an unauthenticated request, so this is both the
-- uniqueness guarantee and the index that read depends on.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_calendar_token
    ON users (calendar_token)
    WHERE calendar_token IS NOT NULL;

COMMENT ON COLUMN users.calendar_token IS
    'Secret path segment of the ICS deadline feed. The URL is the only credential, so rotating this revokes every copy of it.';
