-- Cross-meeting ("workspace") intelligence: ask questions across every meeting a
-- user owns, and semantic search over all their transcripts.
--
-- Two changes are needed on top of V2:
--   1. transcript_chunks carries user_id so retrieval can filter by owner in the
--      same index scan instead of joining meetings on every query.
--   2. chat_messages.meeting_id becomes nullable — a NULL meeting_id means the
--      turn belongs to the user's workspace-wide conversation rather than to one
--      meeting.

-- 1) Owner denormalised onto chunks -----------------------------------------
ALTER TABLE transcript_chunks
    ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

-- Backfill for chunks indexed before this migration.
UPDATE transcript_chunks c
   SET user_id = m.user_id
  FROM meetings m
 WHERE m.id = c.meeting_id
   AND c.user_id IS NULL;

-- Composite index: every workspace query filters on user_id first, then orders
-- by vector distance. Kept separate from the ivfflat index in V2, which stays
-- the one doing the ANN work.
CREATE INDEX IF NOT EXISTS idx_chunks_user ON transcript_chunks(user_id);

-- 2) Workspace-scoped chat turns ---------------------------------------------
ALTER TABLE chat_messages
    ALTER COLUMN meeting_id DROP NOT NULL;

-- History lookups for the workspace conversation (meeting_id IS NULL).
CREATE INDEX IF NOT EXISTS idx_chat_workspace
    ON chat_messages(user_id, created_at)
    WHERE meeting_id IS NULL;
