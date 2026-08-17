-- Who you are, and what language you speak in meetings.
--
-- WHY `job_role` AND NOT `role`
--   `role` is a reserved word in Postgres (CREATE ROLE, SET ROLE, the whole
--   privilege system). It is legal as a column name and works until the first
--   time somebody writes it unquoted in a context where the parser wants the
--   keyword. The rename costs one word here and nothing anywhere else.
--
-- WHY DEPARTMENT AND ROLE EXIST AT ALL
--   They are descriptive, not functional: Recallix is a one-account product, so
--   nothing routes by department and no permission depends on a role. They are
--   here because the account page asks for them and because they go into the
--   account export — data somebody typed about themselves is data Recallix
--   holds of theirs, and Section 23's promise is that all of it comes back out.
--   Nothing else reads them, and this comment is here so nobody later assumes
--   something does.
--
-- WHY `default_language` IS DIFFERENT
--   This one changes the transcript. AssemblyAI is asked to auto-detect when it
--   is blank, and detection is good but not free of mistakes: a short recording,
--   a bilingual standup or a noisy first minute can be labelled wrong, and a
--   wrong label corrupts the whole transcript — the words come back in the wrong
--   language and there is nothing downstream that fixes it. Somebody who always
--   meets in one language can say so once and stop the guessing.
--
--   Blank/NULL means auto-detect, which stays the default because it is the
--   right answer for a multilingual user. Validated against the Language enum
--   (com.recallix.domain.Language) at the service, not here: the eighteen
--   codes are a property of the transcription provider, and pinning them in a
--   CHECK would mean a migration every time that list moves.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS department       TEXT,
    ADD COLUMN IF NOT EXISTS job_role         TEXT,
    ADD COLUMN IF NOT EXISTS default_language TEXT;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS ck_users_department,
    DROP CONSTRAINT IF EXISTS ck_users_job_role,
    DROP CONSTRAINT IF EXISTS ck_users_default_language;

ALTER TABLE users
    ADD CONSTRAINT ck_users_department  CHECK (department IS NULL OR length(department) <= 120),
    ADD CONSTRAINT ck_users_job_role    CHECK (job_role   IS NULL OR length(job_role)   <= 120),
    -- Long enough for a code with a region tag ("pt-BR"), short enough that the
    -- column cannot quietly become a free-text field.
    ADD CONSTRAINT ck_users_default_language CHECK (default_language IS NULL OR length(default_language) <= 8);

COMMENT ON COLUMN users.department IS
    'Descriptive only — nothing routes by it. Included in the account export.';
COMMENT ON COLUMN users.job_role IS
    'Descriptive only. Named job_role because "role" is a Postgres reserved word.';
COMMENT ON COLUMN users.default_language IS
    'ISO-639-1 spoken language for transcription. NULL means auto-detect.';
