-- Template-shaped summaries.
--
-- A summary used to be three fixed fields: a short summary, a long one, and a
-- list of key points. That shape can only express one kind of notes, so a 1:1
-- and a candidate interview came out looking identical.
--
-- Sections are now stored as written, so a template decides both what the
-- summary contains and the order it reads in. The three original columns are
-- KEPT and still populated, because the markdown export, the public share page
-- and the recap email all read them, and none of those should have to know
-- which template ran.
--
-- Deliberately no `summary_templates` table: the built-in set is defined once
-- in the ai-service, which is also where the section instructions live, and the
-- backend serves that list through. Two copies of a template would drift, and
-- the copy that matters is the one the prompt is built from. A table belongs
-- here only once users can write their own.

ALTER TABLE meeting_summaries
    ADD COLUMN IF NOT EXISTS sections_json  JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS template_slug  TEXT;

-- Which template a meeting is summarized with. Held on the meeting rather than
-- the summary so re-running keeps the choice, and so a meeting can be
-- re-summarized under a different template without re-transcribing it.
ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS summary_template TEXT NOT NULL DEFAULT 'general';

-- Existing summaries predate sections. Left empty rather than back-filled: the
-- sections would have to be invented from prose that was written to a
-- different shape, and the reader is better served by the original text, which
-- the three retained columns still hold. Re-summarizing fills them in properly.
COMMENT ON COLUMN meeting_summaries.sections_json IS
    'Ordered sections as written by the template. Empty for summaries produced before V12.';
