-- Mark a summary as out of date when its transcript changes.
--
-- Editing a transcript already does the right thing everywhere else: the flat
-- transcript is rebuilt and pgvector is re-indexed, so chat and search answer
-- from the corrected words immediately. The summary is the exception. It was
-- written from the old text and it stays exactly as it was.
--
-- That is deliberate — re-running the model on every typo fix would spend a
-- call the user did not ask for, and a user correcting twenty segments would
-- pay for twenty summaries. The button to rewrite it has always been there.
--
-- What was missing is the part that makes the choice a choice: nothing told
-- anyone the summary no longer matched. A correction would land, the notes
-- above it would keep asserting the old version, and the reader had no way to
-- know which one to believe. This column is that signal.
--
-- Cleared whenever a summary is written, which happens on re-summarize and on
-- reprocess. Default FALSE: every existing summary matches its transcript
-- unless somebody edits it after this migration.

ALTER TABLE meeting_summaries
    ADD COLUMN IF NOT EXISTS stale BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN meeting_summaries.stale IS
    'True when the transcript was edited after this summary was written.';
