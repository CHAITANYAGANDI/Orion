-- What a workspace-wide search has to read, and the one table that cannot be
-- scanned to serve it.
--
-- WHY ONLY transcript_segments GETS AN INDEX
--   Search now spans meetings, insights, action items, speakers and utterances.
--   Four of those five are tens of rows per user — a meeting has a handful of
--   decisions and a handful of commitments — and a sequential scan over them
--   costs less than the index lookup would. Utterances are the exception by two
--   orders of magnitude: a one-hour meeting is roughly a thousand segments, so a
--   workspace of a hundred meetings is a hundred thousand rows being read on
--   every keystroke. That is the only one worth an index, and adding the other
--   four would be four more indexes to keep warm for no measurable gain.
--
-- WHY 'simple' AND NOT 'english'
--   Two reasons, and either alone would decide it.
--
--   Recallix transcribes in whatever language was spoken and V21 records that
--   per utterance, so a single stemmer would be wrong for part of the archive —
--   English rules applied to German or Hindi text produce tokens that match
--   nothing. Postgres has no "detect the language per row" text search config,
--   and a per-language index would mean one index per language a user might
--   ever speak.
--
--   And this box is typed into a character at a time. 'simple' has no stemming,
--   which is what lets a prefix query work: `stripe:*` matches "Stripe" from the
--   third keystroke onward. Under 'english' the stem of a partial word is not
--   the prefix of the stem of the whole one, so results would appear, vanish and
--   reappear as the user typed. The cost is that "meeting" will not find
--   "meetings" — a real loss, but the smaller of the two.
--
-- WHY A GENERATED COLUMN AND NOT AN EXPRESSION INDEX
--   The transcript is edited (per-line editing, and reprocessing replaces every
--   segment). A stored generated column is recomputed by Postgres on write, so
--   the index cannot drift from the text the way a trigger-maintained column
--   can be made to. It costs a table rewrite once, here, rather than a class of
--   bug that only shows up as "search cannot find the sentence I am looking at".

ALTER TABLE transcript_segments
    ADD COLUMN IF NOT EXISTS search_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(text, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_segments_search
    ON transcript_segments USING GIN (search_tsv);

-- Backs the speaker filter, which asks "did this person say anything in this
-- meeting" once per candidate meeting. idx_segments_meeting alone answers that
-- by reading every utterance of the meeting; with the speaker on the index the
-- EXISTS stops at the first matching entry.
CREATE INDEX IF NOT EXISTS idx_segments_meeting_speaker
    ON transcript_segments (meeting_id, speaker);

COMMENT ON COLUMN transcript_segments.search_tsv IS
    'Full-text vector over `text`, config ''simple'' so it is language-neutral and prefix-searchable. Generated: never written by the application.';
