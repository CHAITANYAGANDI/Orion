-- Turning extracted action items into things you can actually work.
--
-- Until now an action item was a read-only row: the extractor wrote it, the
-- page listed it, and the only thing anybody could change was its status from a
-- dropdown. That is a report, not a tracker. Four things were missing and each
-- one needs a column.
--
-- DUE DATES THAT ARE DATES
--   `due_date` is free text and always has been, deliberately: the extractor is
--   told to record "whatever timing was said, in the words used" — "Tuesday",
--   "end of day", "before the demo". That is the honest record of what was
--   promised and it stays exactly as it is.
--
--   But "overdue" cannot be computed from "Tuesday", and a due-date feature that
--   works on the small minority of items where somebody happened to say a
--   calendar date is not a feature. `due_on` is the resolved date — parsed once
--   at write time against the meeting's own date, so "Tuesday" said in a meeting
--   on the 12th resolves to the 14th. NULL means "we could not tell", which is a
--   perfectly good answer and is why this is a second column rather than a
--   rewrite of the first: the text is what was said, the date is our reading of
--   it, and the UI shows both.
--
-- SURVIVING A REPROCESS
--   `replaceActionItems` deleted every row for the meeting and wrote the
--   extractor's output again. That was harmless while the rows were read-only.
--   The moment you can tick one off, it is data loss — reprocessing a meeting to
--   pick up a corrected transcript would silently un-complete everything and
--   throw away every item added by hand. `edited` marks a row a person has
--   touched, and the reprocess sweep now spares those, exactly as V24 does for
--   insights.
--
-- WHEN IT WAS DONE
--   `completed_at` is not derivable from `status`: a row that says DONE cannot
--   say when, so "what did I finish this week" is unanswerable and the reminder
--   digest cannot congratulate anybody. Stamped on the transition into DONE and
--   cleared on the way out, so it never outlives the status it describes.
--
-- WHERE IT CAME FROM
--   `source_sentence` records the words the commitment was made in, which is
--   most of the value — but the one thing a reader wants next is to hear it,
--   and text cannot be seeked to. `source_start_seconds` is that sentence's
--   position in the recording, resolved by matching the sentence back to a
--   transcript segment when the brief is persisted (and taken directly from the
--   selection for items created by hand, which already know it). NULL when the
--   sentence cannot be located, in which case the UI simply offers no link
--   rather than seeking to the wrong moment.

ALTER TABLE meeting_action_items
    ADD COLUMN IF NOT EXISTS due_on               DATE,
    ADD COLUMN IF NOT EXISTS edited               BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS completed_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS source_start_seconds DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill only the unambiguous ones. Anything already stored as YYYY-MM-DD was
-- either typed into the date picker or came back from the model in ISO form;
-- everything else needs the meeting's date to resolve and is left for the next
-- write to fill in. Guarded by the regex rather than a plain cast because one
-- "end of day" in the table would abort the whole migration.
UPDATE meeting_action_items
SET due_on = due_date::date
WHERE due_on IS NULL
  AND due_date ~ '^\d{4}-\d{2}-\d{2}$';

-- The action-items page sorts by due date within status, and the reminder job
-- asks for everything not DONE that is due on or before a given day. Partial,
-- because a row with no resolvable date is never an answer to either question
-- and there are a lot of them.
CREATE INDEX IF NOT EXISTS idx_actions_due
    ON meeting_action_items (status, due_on)
    WHERE due_on IS NOT NULL;

-- "Whose is this" — the owner filter and My tasks. Case- and space-insensitive
-- for the same reason the known-speaker index is: the extractor writes the name
-- the way the transcript spells it, and " priya" and "Priya" are one person.
CREATE INDEX IF NOT EXISTS idx_actions_owner
    ON meeting_action_items (lower(btrim(owner_name)))
    WHERE owner_name IS NOT NULL;

-- --------------------------------------------------------------------------
-- Comments
-- --------------------------------------------------------------------------
-- A task's status has three values and none of them is "waiting on legal until
-- Thursday". This is the working log: what has happened since, why it slipped,
-- what unblocks it.
--
-- Recallix has one account per workspace, so this is emphatically not a
-- discussion thread — there is nobody to reply to. It is append-a-line, and the
-- UI says so. Kept as rows rather than one growing text field because each entry
-- has its own time, which is the whole point of a log; a single `notes` column
-- would record what you think now and lose when you thought it.
CREATE TABLE IF NOT EXISTS action_item_comments (
    id             TEXT PRIMARY KEY,
    action_item_id TEXT NOT NULL REFERENCES meeting_action_items (id) ON DELETE CASCADE,
    -- Denormalised from the meeting behind the item, as meeting_insights does
    -- and for the same reason: the RLS policy tests this column directly, and
    -- the two-hop EXISTS this saves would run on every read of every comment.
    user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body           TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_action_item_comments_body
        CHECK (length(btrim(body)) BETWEEN 1 AND 4000)
);

-- The only read there is: one item's log, oldest first.
CREATE INDEX IF NOT EXISTS idx_action_item_comments_item
    ON action_item_comments (action_item_id, created_at);

ALTER TABLE action_item_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_item_comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON action_item_comments;
CREATE POLICY tenant_isolation ON action_item_comments
    FOR ALL
    USING      (user_id = app_current_user())
    WITH CHECK (user_id = app_current_user());

-- --------------------------------------------------------------------------
-- Who "me" is, and whether to nag
-- --------------------------------------------------------------------------
-- My tasks needs a name to match owners against, and there is nowhere to get one
-- from: the account has an email, the transcript has "Priya", and nothing joins
-- them. Asking once is the only honest answer. NULL means never asked, which the
-- page distinguishes from "asked and there is nothing of mine" — the first
-- offers a picker of the owner names actually present in the workspace, the
-- second is an empty list.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    -- Off by default. Same rule as the recap: sending somebody mail they did not
    -- ask for is not a sane default.
    ADD COLUMN IF NOT EXISTS task_reminders BOOLEAN NOT NULL DEFAULT FALSE,
    -- The last day a digest went out, as a date rather than a timestamp. The job
    -- runs on a schedule and the process restarts; without this a redeploy at
    -- the wrong minute mails everybody twice. A date is the right grain because
    -- the promise is "at most one a day".
    ADD COLUMN IF NOT EXISTS task_reminder_sent_on DATE;

COMMENT ON COLUMN meeting_action_items.due_on IS
    'Resolved calendar date for due_date, or NULL when the phrasing could not be read as one.';
COMMENT ON COLUMN meeting_action_items.edited IS
    'A person has changed this row; a reprocess must not overwrite or delete it.';
COMMENT ON TABLE action_item_comments IS
    'Private working log against one action item. Not a discussion — one account per workspace.';
