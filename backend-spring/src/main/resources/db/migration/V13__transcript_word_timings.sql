-- Per-word timings on each transcript segment.
--
-- The transcript view highlights the word being spoken and lets you click one
-- to play from it. Both were previously estimated by spreading a segment's
-- span evenly across its text, which assumes speech has no pauses. Diarized
-- utterances used to be short enough to hide the error — every segment
-- boundary resnapped the highlight to a real timestamp — but a provider that
-- groups a whole speaker turn returns segments of thirty seconds or more, and
-- over that distance the estimate visibly outruns the voice.
--
-- Both AssemblyAI and Deepgram return these timings; we were discarding them.
--
-- Stored as JSONB on the segment rather than as a `transcript_words` table:
-- words are only ever read as a whole segment's worth, alongside the segment,
-- and never queried or joined individually. A row per word would multiply the
-- table by ~100x to serve a read that always wants the array.

ALTER TABLE transcript_segments
    ADD COLUMN IF NOT EXISTS words_json JSONB NOT NULL DEFAULT '[]';

-- Existing transcripts predate this and stay empty. The UI falls back to the
-- old estimate when the array is empty, so they keep working exactly as they
-- did; reprocessing a meeting fills them in.
COMMENT ON COLUMN transcript_segments.words_json IS
    'Per-word {text,start,end} in seconds. Empty for segments recorded before V13.';
