-- Starter questions that are about something.
--
-- The chips above a chat were three hard-coded questions, the same three on
-- every meeting. That fails in the way that does not show up as a bug: "What
-- did we decide?" sits on a meeting that decided nothing, and by the second
-- meeting a user has read the same row twice and stops reading it at all. A
-- suggestion earns its place by naming something in *this* material.
--
-- TWO DIFFERENT LIFETIMES, WHICH IS WHY THIS IS TWO DIFFERENT THINGS
--
--   A meeting's questions are a function of its summary, and a summary does not
--   change on its own. So they are generated once, when the meeting is
--   summarized, and stored beside it — opening a meeting costs nothing, and
--   re-summarizing under another template regenerates them along with the
--   sections they were drawn from. A column, not a table.
--
--   A workspace has no such moment. There is no "workspace processed" event to
--   hang generation off, and the right questions change as meetings land. So
--   they are generated on request and cached per user with the time they were
--   made, and the cache is invalidated by either a new meeting or a few hours
--   passing. A table, keyed by user.
--
-- Both are allowed to be empty, and empty is not a failure state. The UI keeps
-- a written-by-hand fallback set, and three hand-written prompts beat three
-- generic ones invented to avoid returning nothing.

ALTER TABLE meeting_summaries
    ADD COLUMN IF NOT EXISTS suggestions_json JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN meeting_summaries.suggestions_json IS
    'Starter chat questions generated from this summary. Empty is valid.';

CREATE TABLE IF NOT EXISTS workspace_suggestions (
    -- One row per user: this is a cache, not a history. Keeping old
    -- generations would mean deciding which is current on every read.
    user_id      TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    prompts_json JSONB       NOT NULL DEFAULT '[]',
    -- What the freshness check compares against, both for the age limit and
    -- for "has a meeting arrived since these were written".
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Row-Level Security (see V9)
-- --------------------------------------------------------------------------
-- The row is keyed by user_id, so it takes the same ownership policy as every
-- other user-owned table. FORCE because the app connects as the table owner and
-- Postgres exempts an owner from its own policies otherwise.
ALTER TABLE workspace_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_suggestions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace_suggestions;
-- Ownership is the only test: V11 dropped app_is_system(), and the system
-- exemption is BYPASSRLS on the recallix_sys connection rather than a flag a
-- policy consults. Referencing it is what made V20 fail to apply.
CREATE POLICY tenant_isolation ON workspace_suggestions
    FOR ALL
    USING      (user_id = app_current_user())
    WITH CHECK (user_id = app_current_user());

COMMENT ON TABLE workspace_suggestions IS
    'Cached starter questions for a user''s workspace chat; regenerated on age or on a new meeting.';
