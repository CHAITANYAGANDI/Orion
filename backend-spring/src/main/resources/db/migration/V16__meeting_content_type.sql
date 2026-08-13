-- Remember what kind of media a meeting actually is.
--
-- Video uploads have always been accepted (`ALLOWED_PREFIXES` covers `video/`)
-- and transcribe correctly, because AssemblyAI and Deepgram demux the audio
-- track themselves. But nothing downstream ever learned the file was a video:
-- the meeting page renders every recording through an `<audio>` element, so an
-- uploaded MP4 played back as sound with no picture and no way to get at it.
--
-- The content type is already sent on the presign request and validated there;
-- it was simply thrown away afterwards. Keeping it costs one column and is the
-- only thing the player needs to pick the right element.
--
-- Deliberately not derived from the object key's extension: the extension is
-- attacker-influenced (it comes from the uploaded filename) and absent
-- entirely for YouTube imports, whereas the content type is validated against
-- an allowlist before this row is written.

ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS content_type TEXT;

-- Null for every meeting created before this migration. The player treats null
-- as audio, which is what those meetings were being rendered as anyway, so
-- existing rows keep their current behaviour rather than changing under the
-- user. Re-uploading is what fills it in.
COMMENT ON COLUMN meetings.content_type IS
    'Validated MIME type of the uploaded media. Null for meetings created before V16.';
