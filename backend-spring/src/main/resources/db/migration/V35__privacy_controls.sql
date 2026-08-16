-- Getting data out, and getting rid of it.
--
-- Recallix already had the architecture for privacy and none of the controls.
-- Row-level security means one account cannot read another's rows; the audio
-- lives in a private bucket reachable only through a URL we sign for fifteen
-- minutes; a share link is opt-in, per meeting, and revocable. All of that is
-- true, and none of it was reachable from the product: the only erasure on
-- offer was all-or-nothing per meeting, retention was forever, the settings
-- page's "Danger zone" popped a toast saying deletion was not implemented, and
-- an account holder had no way to take their own data with them.
--
-- This migration adds the state behind four controls.
--
-- WHY ERASURE HAS GRAINS
--   "Delete the meeting" is the wrong unit for the commonest real request. The
--   recording is the sensitive artefact — it is somebody's voice, it is the
--   largest object, and it is the one thing that can be re-listened to out of
--   context. The notes drawn from it are usually the part worth keeping. So the
--   audio and the transcript can each go on their own, and what is left says so
--   rather than looking like a meeting that never had one. A YouTube import has
--   no object either, and a page cannot tell those two apart without a stamp.
--
-- WHY A TIMESTAMP RATHER THAN A FLAG
--   The question asked afterwards is always "when", and it is asked precisely
--   when it matters: a subject access request, a retention audit, or somebody
--   wondering whether the recording was still there last Tuesday. NULL means
--   never erased, which is also the honest default for every existing row.
--
-- WHY CONSENT IS STORED
--   The record page already gates recording behind a tick confirming everyone
--   was told. Until now that tick enabled a button and was then forgotten, which
--   makes it theatre. Stamped on the meeting it becomes the one thing anybody
--   would ever want from it: a record that the person who pressed record said
--   they had asked. It is their assertion, not our verification, and the column
--   comment says so.

ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS audio_deleted_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS transcript_deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS consent_confirmed_at  TIMESTAMPTZ;

COMMENT ON COLUMN meetings.audio_deleted_at IS
    'When the recording was erased from object storage. NULL means never erased — which is not the same as never having had one.';
COMMENT ON COLUMN meetings.transcript_deleted_at IS
    'When the transcript, its segments, its marks and its embeddings were erased. The summary and action items survive it.';
COMMENT ON COLUMN meetings.consent_confirmed_at IS
    'When the person recording confirmed they had told the room. Their assertion, recorded; not something Recallix can verify.';

-- --------------------------------------------------------------------------
-- Retention
-- --------------------------------------------------------------------------
-- Two dials rather than one, because they answer different questions and the
-- honest answers are usually different numbers. "How long do you keep the
-- recording of my voice" is asked by the people in the meeting; "how long do
-- you keep the notes" is asked by the person who owns the account. Thirty days
-- and forever is a perfectly coherent policy, and a single dial cannot express
-- it.
--
-- NULL means keep indefinitely, which is what every existing account has been
-- doing and therefore the only safe default. A retention policy that switched
-- itself on during a deploy would delete data nobody agreed to lose.
--
-- The service refuses a whole-meeting window shorter than the audio one — not
-- because it would break anything, but because it is always a mistake: it means
-- the meeting is deleted before the rule that was supposed to protect the audio
-- inside it ever runs, so the narrower promise is never actually kept.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS audio_retention_days   INTEGER,
    ADD COLUMN IF NOT EXISTS meeting_retention_days INTEGER,
    ADD CONSTRAINT ck_users_audio_retention
        CHECK (audio_retention_days IS NULL OR audio_retention_days BETWEEN 1 AND 3650),
    ADD CONSTRAINT ck_users_meeting_retention
        CHECK (meeting_retention_days IS NULL OR meeting_retention_days BETWEEN 1 AND 3650);

COMMENT ON COLUMN users.audio_retention_days IS
    'Erase the recording this many days after the meeting was created, keeping everything drawn from it. NULL keeps it.';
COMMENT ON COLUMN users.meeting_retention_days IS
    'Erase the whole meeting this many days after it was created. NULL keeps it.';

-- The retention pass asks "which of this account's meetings are older than X",
-- once per account holding a policy. V1's index covers the user half only, so
-- every night's pass would read that user's entire archive and throw most of it
-- away — the work growing with exactly the thing retention exists to keep small.
-- The composite also serves the meetings list, which has always ordered by
-- created_at within a user.
CREATE INDEX IF NOT EXISTS idx_meetings_user_created ON meetings (user_id, created_at);
