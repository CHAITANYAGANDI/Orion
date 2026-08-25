-- Which processing run each embedded chunk came out of.
--
-- The transcript, summary and insights are all replaced by Spring inside
-- `applyResult`, which since V57 refuses a callback from a run a reprocess has
-- overtaken. The embeddings are not: the ai-service writes them into pgvector
-- itself, during processing, well before Spring ever sees the result. So a
-- redelivered attempt-1 execution -- one whose result callback is about to be
-- rejected as stale -- would still have deleted every chunk of the meeting and
-- written its own back, and "ask this meeting" would answer from the transcript
-- the user had just asked to have replaced.
--
-- Stamping the run on the row turns the indexer's blind `DELETE ... WHERE
-- meeting_id = ?` into one scoped to its own generation. An execution then has
-- no statement available to it that can touch a newer run's rows -- not a check
-- that could be raced, but an absence of reach.
--
-- Retrieval reads the newest generation present, which is deliberately not "the
-- meeting's current attempt". Reprocessing does not delete the transcript, the
-- summary or the action items while it runs, and chat should not go blind
-- either: the previous run stays answerable until the new one lands, exactly as
-- the page beside it does.

ALTER TABLE transcript_chunks
    ADD COLUMN IF NOT EXISTS processing_attempt INTEGER NOT NULL DEFAULT 1;

-- Everything indexed before this column existed belongs to whatever run the
-- meeting is on now. Any other value would leave those chunks looking like an
-- older generation than they are; as the newest present they stay visible
-- either way, but the number should say something true.
UPDATE transcript_chunks c
   SET processing_attempt = m.processing_attempt
  FROM meetings m
 WHERE m.id = c.meeting_id
   AND c.processing_attempt <> m.processing_attempt;

-- Leads with meeting_id, so it does everything idx_chunks_meeting did, and
-- carries the generation so "is there a newer one?" is answered from the index
-- rather than by reading rows.
CREATE INDEX IF NOT EXISTS idx_chunks_meeting_generation
    ON transcript_chunks (meeting_id, processing_attempt DESC);
DROP INDEX IF EXISTS idx_chunks_meeting;
