-- The language a meeting was *held* in, as the user says it, per meeting.
--
-- WHY THIS IS NOT `meetings.language`
--   That column is an output: the worker writes what the transcriber reports it
--   heard. This one is an input — what the user tells the transcriber to expect
--   before it listens. Storing both in one column would mean a correction was
--   indistinguishable from a detection, and the first reprocess would overwrite
--   the correction with the same wrong guess that made it necessary.
--
-- WHY IT IS NOT ENOUGH TO HAVE THE ACCOUNT-WIDE SETTING
--   V38 gave an account a default transcription language, sent with every job.
--   That is the right default and the wrong granularity for the case this
--   exists for: an English-speaking account with one French meeting in it. The
--   only way to fix that today is to change the account default, reprocess, and
--   remember to change it back — and forgetting leaves every later upload
--   transcribed as French.
--
--   So: this overrides the account default for one meeting, and NULL means
--   "use the account's answer", which is what every existing row does.
--
-- WHY IT SURVIVES A REPROCESS
--   It is read at enqueue, every time, rather than consumed once. Somebody who
--   told us a meeting is in French meant it about the meeting, not about that
--   one run — and a reprocess that quietly reverted to auto-detect would undo
--   the fix without saying so.
--
-- NOT CONSTRAINED TO A CODE LIST HERE
--   The eighteen transcribable languages live in the Language enum, because
--   they are a property of the transcription provider rather than of this
--   database. A CHECK here would be a second copy of that list, kept in sync by
--   hand, and wrong the first time the provider adds a language.

ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS spoken_language TEXT;

COMMENT ON COLUMN meetings.spoken_language IS
    'ISO-639-1 the user says this meeting is in, overriding users.default_language at enqueue. NULL means use the account default. Distinct from meetings.language, which is what the transcriber reported hearing.';
