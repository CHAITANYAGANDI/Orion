-- Verified key quotations, with the moment each was said.
--
-- Stored alongside the summary rather than as their own table, matching
-- key_points_json and sections_json: quotations are only ever read as a whole
-- summary's worth, never queried or joined individually, so a row per quote
-- would buy nothing.
--
-- What reaches this column has already been matched back against the transcript
-- by the worker (app/quotes.py) — anything the model could not have copied from
-- it was dropped before the callback. That check is the point of the feature: a
-- quotation is the one part of a brief that claims to be exact, and a
-- paraphrase presented as a quote reads as evidence while being none.
--
-- Each entry is {text, speaker, start}. `speaker` and `start` come from the
-- segment the quote was found in, never from the model, which is what makes a
-- quotation clickable to the moment it was spoken.

ALTER TABLE meeting_summaries
    ADD COLUMN IF NOT EXISTS quotes_json JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN meeting_summaries.quotes_json IS
    'Verified quotations: [{text, speaker, start}]. Empty for summaries '
    'generated before V22, and for meetings where nothing verified.';
