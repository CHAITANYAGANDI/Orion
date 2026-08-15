-- Named, separable chat conversations.
--
-- Until now each chat was a single unbounded thread: one per meeting, and one
-- for the workspace. That is fine for a handful of questions and wrong the
-- moment somebody uses it. Asking about last week's action items and then about
-- a contract risk puts two unrelated enquiries in one scroll, and the only
-- controls available were "read it all" or "clear it all" — so the rational
-- move became clearing history, which throws away the thing that made it worth
-- storing.
--
-- A conversation is the unit people actually think in: a question and its
-- follow-ups, keepable or discardable on its own.
--
-- WHY meeting_id STAYS NULLABLE
--   Same discriminator the messages already used. NULL means the workspace-wide
--   conversation; a value scopes it to one meeting. Two tables would duplicate
--   an identical schema, and every list/rename/delete path with it.
--
-- WHY THE TITLE LIVES HERE
--   It is generated once from the first exchange and then owned by the user,
--   who can rename it. Deriving it on read instead would mean re-deriving it on
--   every page load, and a title that quietly changed under a renamed row is
--   not a title.
--
-- WHY THE BACKFILL IS NOT OPTIONAL
--   Existing messages have to land somewhere or they vanish from the UI, which
--   for chat history means losing the record permanently. Every existing thread
--   becomes one conversation, named after the question that started it.

CREATE TABLE IF NOT EXISTS chat_conversations (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- NULL = the workspace-wide conversation; set = scoped to one meeting.
    meeting_id  TEXT REFERENCES meetings (id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- When it was last spoken to. This, not created_at, is what the picker
    -- sorts and groups by: a conversation returned to today belongs under
    -- "Today" however old it is.
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_chat_conversations_title CHECK (length(title) <= 200)
);

-- The picker's read: this user's conversations at one scope, most recent first.
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user
    ON chat_conversations (user_id, meeting_id, updated_at DESC);

ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS conversation_id TEXT REFERENCES chat_conversations (id) ON DELETE CASCADE;

-- --------------------------------------------------------------------------
-- Backfill: one conversation per existing thread
-- --------------------------------------------------------------------------
-- Grouped by (user, meeting) with NULL meaning the workspace thread, which is
-- exactly how the application read these before this migration existed.
INSERT INTO chat_conversations (id, user_id, meeting_id, title, created_at, updated_at)
SELECT
    'cnv_' || substr(md5(random()::text || clock_timestamp()::text || m.user_id), 1, 20),
    m.user_id,
    m.meeting_id,
    -- Named after the question that started it, trimmed to something that fits
    -- a list. Generated titles only apply from here on; renaming is available
    -- for anything this gets wrong.
    COALESCE(
        (SELECT left(btrim(c.content), 80)
           FROM chat_messages c
          WHERE c.user_id = m.user_id
            AND c.meeting_id IS NOT DISTINCT FROM m.meeting_id
            AND c.role = 'user'
          ORDER BY c.created_at
          LIMIT 1),
        'Earlier conversation'
    ),
    min(m.created_at),
    max(m.created_at)
  FROM chat_messages m
 WHERE m.conversation_id IS NULL
 GROUP BY m.user_id, m.meeting_id;

UPDATE chat_messages m
   SET conversation_id = c.id
  FROM chat_conversations c
 WHERE m.conversation_id IS NULL
   AND c.user_id = m.user_id
   AND c.meeting_id IS NOT DISTINCT FROM m.meeting_id;

-- Only now that every row has one. A message with no conversation cannot be
-- reached by any read path, so it is indistinguishable from deleted.
ALTER TABLE chat_messages
    ALTER COLUMN conversation_id SET NOT NULL;

-- The message read: one conversation, in order.
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
    ON chat_messages (conversation_id, created_at);

-- --------------------------------------------------------------------------
-- Row-Level Security (see V9)
-- --------------------------------------------------------------------------
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_conversations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chat_conversations;
-- Ownership is the only test: V11 dropped app_is_system(), and the system
-- exemption is BYPASSRLS on the recallix_sys connection rather than a flag a
-- policy consults.
CREATE POLICY tenant_isolation ON chat_conversations
    FOR ALL
    USING      (user_id = app_current_user())
    WITH CHECK (user_id = app_current_user());

COMMENT ON TABLE chat_conversations IS
    'One named chat thread. meeting_id NULL means the workspace-wide chat.';
COMMENT ON COLUMN chat_conversations.updated_at IS
    'Last message time — what the history picker sorts and groups by.';
