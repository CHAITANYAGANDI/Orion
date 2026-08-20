-- Canonical speaker identity on each transcript segment.
--
-- Two bugs made this necessary, and they were the same mistake seen twice:
-- Recallix stored the provider's speaker label as if it were a Recallix
-- speaker number.
--
-- AssemblyAI clusters voices and names the clusters "A", "B", "C"… The letters
-- are identifiers, not positions — "D" does not mean "the fourth person", it
-- means whichever bucket that voice landed in. Recallix rendered them by
-- alphabet position, so a two-person meeting whose voices clustered as A and D
-- displayed *Speaker 1 and Speaker 4*, which reads as two people missing from
-- the room. Numbering is now assigned by order of first appearance, in the
-- worker, before anything is written here.
--
-- That renumbering is lossy, hence these columns:
--
--   speaker_key    Meeting-local identity ("spk_2"), stable across renames.
--                  `speaker` is the display name and is what a rename
--                  overwrites; the key is what a colour is picked from, so
--                  renaming Speaker 2 to Sarah no longer recolours her.
--
--   speaker_raw    The provider's own cluster id. Never displayed. It is what
--                  makes a diarization complaint diagnosable after the fact —
--                  the display label alone cannot distinguish "the provider
--                  merged two people" from "Recallix mislabelled one".
--
--   speaker_status Whether the provider actually attributed this turn, or
--                  declined to. Already computed in the worker and thrown away
--                  at this boundary, which meant an unattributed turn arrived
--                  looking exactly like a confident one.

ALTER TABLE transcript_segments
    ADD COLUMN IF NOT EXISTS speaker_key TEXT,
    ADD COLUMN IF NOT EXISTS speaker_raw TEXT,
    ADD COLUMN IF NOT EXISTS speaker_status TEXT NOT NULL DEFAULT 'attributed';

-- Transcripts written before this migration keep NULL identity columns. That
-- is deliberate rather than a backfill: their `speaker` strings came from the
-- old alphabet-position mapping, so any key invented for them now would be
-- guessing which voice was which. Readers fall back to the display name, which
-- is exactly how those transcripts behaved before — and reprocessing a meeting
-- fills the columns in properly.
COMMENT ON COLUMN transcript_segments.speaker_key IS
    'Meeting-local speaker identity ("spk_1"), stable across renames. NULL before V46.';
COMMENT ON COLUMN transcript_segments.speaker_raw IS
    'The provider''s own cluster id ("A"). Diagnostics only, never displayed.';
COMMENT ON COLUMN transcript_segments.speaker_status IS
    'attributed | unknown. "unknown" is a real answer: better than filing a turn under Speaker 1.';
