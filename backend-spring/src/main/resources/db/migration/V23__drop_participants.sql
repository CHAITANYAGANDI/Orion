-- Remove the participants list.
--
-- Recallix never joins a meeting, so it never learns who was in one. The column
-- only ever held what the uploader typed into a box before processing started —
-- which, for almost every meeting, was nothing. An empty list rendered as an
-- empty list, and a filled one was a claim nobody had checked against the audio.
--
-- Speaker labels on the transcript are the real answer to "who was here", and
-- they are derived from the recording itself. This column was the guess that
-- competed with them.
--
-- Destructive and deliberate, matching V14/V15/V18/V19: the column goes rather
-- than lingering as a field no code writes and a future reader has to prove is
-- dead.

ALTER TABLE meetings DROP COLUMN IF EXISTS participants;
