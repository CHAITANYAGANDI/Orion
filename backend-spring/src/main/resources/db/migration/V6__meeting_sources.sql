-- Alternative meeting sources: YouTube links and PDF documents.
--
-- Until now every meeting arrived as an uploaded audio/video file. Two more
-- sources now reach the same pipeline, so meetings need to record which one
-- they came from: the UI hides the audio player for text-only sources, and the
-- worker uses it to decide whether to transcribe at all.

ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS source_type VARCHAR(16) NOT NULL DEFAULT 'AUDIO',
    -- Only set for YOUTUBE; AUDIO and DOCUMENT carry their content in S3.
    ADD COLUMN IF NOT EXISTS source_url TEXT;

-- Every pre-existing row was an upload, which the DEFAULT already covers.
-- The constraint is added afterwards so the backfill cannot fail against it.
ALTER TABLE meetings
    DROP CONSTRAINT IF EXISTS meetings_source_type_check;
ALTER TABLE meetings
    ADD CONSTRAINT meetings_source_type_check
        CHECK (source_type IN ('AUDIO', 'YOUTUBE', 'DOCUMENT'));

-- A YouTube video should only be imported once per user; re-importing the same
-- URL is nearly always an accident (double-click, back button) and would burn
-- the transcription quota twice. Partial so the column stays NULL for uploads.
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_user_source_url
    ON meetings (user_id, source_url)
    WHERE source_url IS NOT NULL;
