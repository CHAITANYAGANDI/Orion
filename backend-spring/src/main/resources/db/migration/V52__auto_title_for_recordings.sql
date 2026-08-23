-- --------------------------------------------------------------------------
-- V52 — let a recording be named by what was said in it
-- --------------------------------------------------------------------------
--
-- A browser recording arrives called `Recording — 20/08/2026, 05:03:43`, because
-- at the moment it is saved that is genuinely all anybody knows about it. It is
-- a fine placeholder and a poor name: a list of a dozen of them cannot be
-- scanned, searched, or told apart without opening each one.
--
-- The summarizer already reads the whole transcript. It now returns a title
-- from the same pass, and this column is what decides whether that title is
-- allowed to land.
--
-- WHY A COLUMN, rather than matching the placeholder's text. The string is
-- built in the browser from `toLocaleString()`, so its shape depends on the
-- user's locale and its prefix is a frontend constant. A backend that decided
-- "is this still the default name?" by matching `Recording — ` would be one
-- refactor away from silently never renaming anything again, and nothing would
-- fail — meetings would just quietly keep their timestamps. A boolean says the
-- thing outright: this name was ours, not theirs.
--
-- FALSE for everything that already exists, and that is deliberate rather than
-- merely convenient. Renaming meetings somebody has had for months, on the
-- deploy that ships this, would rewrite the labels they navigate by — including
-- files they uploaded under names they chose. The flag is set going forward, by
-- `MeetingService.createMeeting`, and only for recordings.
--
-- Cleared the moment anybody renames the meeting themselves, so a name typed
-- while the transcript is still processing is never overwritten by the model
-- that finishes after it.

ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS auto_title BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN meetings.auto_title IS
    'The title is a placeholder Recallix generated, so the worker may replace it '
    'with one read from the transcript. Cleared by any manual rename.';
