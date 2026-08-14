-- Decisions and risks, on the record.
--
-- V14 dropped the previous pair of features and this is deliberately not a
-- restoration of them. What was dropped extracted decisions with their own LLM
-- pass, which produced a list that disagreed with the summary sitting beside it
-- on the page, and gave the reader no way to tell which reading to trust.
--
-- These rows are *read out of the summary sections that were already written*.
-- The Decisions section and the decision store are the same words, so they
-- cannot drift apart, and correcting one corrects both. See ai-service's
-- `app/insights.py` for which sections count and why.
--
-- WHY ONE TABLE
--   A decision and a risk have identical structure, identical lifecycle and
--   identical permissions. Two tables would be two identical schemas and two
--   identical CRUD paths for a difference that is one word. `kind` keeps them
--   separable — and `source_section` keeps "a risk" distinguishable from "a
--   blocker" after both have landed here.
--
-- WHY EDITABLE
--   Because a store nobody can correct is a store nobody should trust. These
--   rows feed workspace chat, where they are presented to the model as the
--   record of what was settled — so a wrong one is not a cosmetic error, it is
--   a wrong answer to "does this conflict with what we decided in March?".
--   Making them visible and editable is what earns them that role: the ledger
--   does not create trustworthy data, it borrows data that people can see and
--   correct.
--
--   `edited` marks a row a human has touched, so re-summarizing can replace the
--   derived rows without discarding the corrections.

CREATE TABLE IF NOT EXISTS meeting_insights (
    id             TEXT PRIMARY KEY,
    meeting_id     TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    -- Denormalised from meetings so the RLS policy below can test ownership
    -- without a join, matching every other user-owned table since V9.
    user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    text           TEXT NOT NULL,
    -- Which summary section it came from ('decisions', 'blockers', 'concerns'
    -- ...). Empty for rows a user added by hand.
    source_section TEXT NOT NULL DEFAULT '',
    -- True once a human has edited or added it. Re-deriving must not silently
    -- undo somebody's correction.
    edited         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_meeting_insights_kind CHECK (kind IN ('DECISION', 'RISK')),
    CONSTRAINT ck_meeting_insights_text CHECK (length(btrim(text)) BETWEEN 1 AND 2000)
);

-- The read on the meeting page: one meeting, both kinds, in insertion order.
CREATE INDEX IF NOT EXISTS idx_meeting_insights_meeting
    ON meeting_insights (meeting_id, kind, created_at);

-- The read in workspace chat: every decision a user has, oldest first. Ordering
-- by created_at here is a fallback — the query orders by the meeting's date,
-- which is what "earlier decision" actually means.
CREATE INDEX IF NOT EXISTS idx_meeting_insights_user_kind
    ON meeting_insights (user_id, kind, created_at);

-- --------------------------------------------------------------------------
-- Row-Level Security (see V9)
-- --------------------------------------------------------------------------
ALTER TABLE meeting_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_insights FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON meeting_insights;
-- Ownership is the only test: V11 dropped app_is_system(), and the system
-- exemption is BYPASSRLS on the recallix_sys connection rather than a flag a
-- policy consults. Referencing it is what made V20 fail to apply.
CREATE POLICY tenant_isolation ON meeting_insights
    FOR ALL
    USING      (user_id = app_current_user())
    WITH CHECK (user_id = app_current_user());

COMMENT ON TABLE meeting_insights IS
    'Decisions and risks read out of a meeting''s summary sections; user-editable.';
