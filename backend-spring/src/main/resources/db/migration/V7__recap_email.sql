-- Automatic recap email when a meeting finishes processing.
--
-- The settings page has offered this toggle since the first build, but stored
-- it in browser state and never acted on it. These columns move the preference
-- server-side, where the worker callback can actually see it.

ALTER TABLE users
    -- Off by default: sending mail on someone's behalf is not a sane default.
    ADD COLUMN IF NOT EXISTS auto_email_recap BOOLEAN NOT NULL DEFAULT FALSE,
    -- Where to send it. Falls back to the account email when NULL, but a user
    -- may well want recaps somewhere other than their sign-in address.
    ADD COLUMN IF NOT EXISTS recap_email VARCHAR(320);

-- Reprocessing a meeting re-fires the READY event. Without a record of the
-- send, every reprocess would mail the same recap again.
ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS recap_sent_at TIMESTAMPTZ,
    -- Detected transcription language, denormalised from meeting_transcripts.
    -- The list endpoint renders a language badge per row; reading it from the
    -- transcript there would be one extra query per meeting in the page.
    -- NULL until processing finishes, which the UI shows as "unknown" rather
    -- than assuming English.
    ADD COLUMN IF NOT EXISTS language VARCHAR(16);

-- Backfill from transcripts already persisted, so existing meetings show a
-- badge without needing a reprocess.
UPDATE meetings m
SET language = t.language
FROM (
    SELECT DISTINCT ON (meeting_id) meeting_id, language
    FROM meeting_transcripts
    ORDER BY meeting_id, created_at DESC
) t
WHERE t.meeting_id = m.id
  AND m.language IS NULL
  AND t.language IS NOT NULL;
