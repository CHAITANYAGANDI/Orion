-- Things a person marked in a transcript: highlights, bookmarks and notes.
--
-- WHY ONE TABLE
--   Same argument as V24. A highlight, a bookmark and a note are the same row
--   with different fields filled in: all three are "this part of this meeting
--   matters", anchored to a moment, owned by one user, created and deleted the
--   same way. `kind` keeps them separable in a list without three schemas and
--   three CRUD paths for a difference that is one word.
--
-- WHY THE ANCHOR IS STORED THREE TIMES
--   This is the part that matters, and it is a direct consequence of Recallix
--   letting people correct a transcript (V13's word timings, and the per-line
--   editing above it). An annotation pinned to character offsets in a sentence
--   is broken by the next edit of that sentence — silently, because the offsets
--   still resolve, just to different words. So each range carries:
--
--     segmentId + startOffset/endOffset   fast path, exact while the line is
--                                         untouched
--     quote                               the words themselves, so a line that
--                                         was edited elsewhere can be re-found
--     startSeconds/endSeconds on the row  a timestamp, which survives even a
--                                         reprocess that replaces every segment
--
--   The reader tries them in that order and degrades rather than lying: a
--   highlight whose words are gone stops rendering inline and is shown in the
--   list marked as such, instead of quietly landing on the wrong sentence.
--
-- WHY `ranges` IS JSONB AND NOT A CHILD TABLE
--   Same reasoning as V13's words_json. A selection that crosses an utterance
--   boundary — common, because diarization splits on pauses, not on sentences —
--   covers two or three segments. Those ranges are only ever read as a whole
--   moment's worth, alongside the moment, and are never queried or joined
--   individually. A child table would be a join and a second CRUD path to serve
--   a read that always wants the array.
--
-- WHY NO FOREIGN KEY ON segmentId
--   Deliberate. Reprocessing a meeting deletes and rebuilds transcript_segments,
--   so a cascading FK would destroy every highlight the user had made the moment
--   they asked for a better transcription. The quote and the timestamps are
--   enough to find the moment again; a dangling id is handled by the reader.
--
-- WHAT IS NOT HERE, AND WHY
--   No thread/parent column, no mentions, no reactions. Those are all one
--   person addressing another, and Recallix has one user per workspace —
--   there is no second account to reply to, mention or react at. A note here
--   is a private annotation, not a comment.

CREATE TABLE IF NOT EXISTS transcript_moments (
    id            TEXT PRIMARY KEY,
    meeting_id    TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    -- Denormalised from meetings so the RLS policy tests ownership without a
    -- join, matching every user-owned table since V9.
    user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,

    -- [{segmentId, startOffset, endOffset, quote}], in reading order. Empty for
    -- a bookmark, which marks a time rather than a passage.
    ranges        JSONB NOT NULL DEFAULT '[]',

    -- The selected words, joined. Duplicated out of `ranges` so the list can be
    -- rendered, searched and exported without unpacking JSON.
    quote         TEXT NOT NULL DEFAULT '',
    -- The user's own words: a note's body, or a bookmark's label.
    body          TEXT NOT NULL DEFAULT '',
    -- Who was speaking, denormalised. Needed for attribution in the list and on
    -- the clipboard, and the segment it came from may no longer exist.
    speaker       TEXT NOT NULL DEFAULT '',

    start_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    end_seconds   DOUBLE PRECISION NOT NULL DEFAULT 0,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_transcript_moments_kind
        CHECK (kind IN ('HIGHLIGHT', 'BOOKMARK', 'NOTE')),
    -- A note with no body is an empty annotation on a passage: nothing to read,
    -- and indistinguishable from a highlight in the list.
    CONSTRAINT ck_transcript_moments_note_body
        CHECK (kind <> 'NOTE' OR length(btrim(body)) > 0),
    -- A highlight with nothing quoted cannot be drawn, and cannot be re-found
    -- after an edit.
    CONSTRAINT ck_transcript_moments_highlight_quote
        CHECK (kind <> 'HIGHLIGHT' OR length(btrim(quote)) > 0),
    CONSTRAINT ck_transcript_moments_sizes
        CHECK (length(quote) <= 5000 AND length(body) <= 5000)
);

-- The read on the meeting page: one meeting's moments in transcript order,
-- which is what both the inline rendering and the list want.
CREATE INDEX IF NOT EXISTS idx_transcript_moments_meeting
    ON transcript_moments (meeting_id, start_seconds);

-- Ordered by recency rather than by transcript position: this serves "what have
-- I marked lately", across meetings, where the timestamp within a meeting is
-- meaningless.
CREATE INDEX IF NOT EXISTS idx_transcript_moments_user
    ON transcript_moments (user_id, created_at DESC);

-- --------------------------------------------------------------------------
-- Row-Level Security (see V9)
-- --------------------------------------------------------------------------
ALTER TABLE transcript_moments ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_moments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON transcript_moments;
-- Ownership is the only test: V11 dropped app_is_system(), and the system
-- exemption is BYPASSRLS on the recallix_sys connection rather than a flag a
-- policy consults. Referencing it is what made V20 fail to apply.
CREATE POLICY tenant_isolation ON transcript_moments
    FOR ALL
    USING      (user_id = app_current_user())
    WITH CHECK (user_id = app_current_user());

COMMENT ON TABLE transcript_moments IS
    'Highlights, bookmarks and private notes a user marked on a transcript.';
COMMENT ON COLUMN transcript_moments.ranges IS
    'Per-segment [{segmentId,startOffset,endOffset,quote}]. Offsets are the fast anchor; quote is the recovery anchor after a transcript edit.';
