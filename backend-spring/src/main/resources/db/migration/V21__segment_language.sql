-- Per-utterance language, for meetings held in more than one.
--
-- `meetings.language` records what the provider detected for the whole
-- recording. That is right for most meetings and wrong for the ones people
-- notice: a standup held half in Telugu and half in English is labelled `te`,
-- and the English half sits under a label that does not describe it.
--
-- Deliberately NULL for the common case. This column is set only when an
-- utterance is in a *different* language from the meeting's and detection was
-- confident, so a monolingual meeting stores nothing and the marker keeps
-- meaning something. NULL therefore reads as "same as the meeting, or not
-- known" — never as "detection failed".

ALTER TABLE transcript_segments
    ADD COLUMN IF NOT EXISTS language VARCHAR(16);

COMMENT ON COLUMN transcript_segments.language IS
    'ISO-639-1 code, set only when this utterance differs from meetings.language. '
    'NULL means same-as-meeting or undetermined. Empty for transcripts predating V21.';
