-- Projects: the one place a meeting lives, and a third scope to ask questions at.
--
-- WHY "PROJECT" AND NOT "FOLDER"
--   A folder is a place you put a file. A project is a thing that is happening,
--   and that difference is the whole feature: it is what makes "ask Recallix
--   about this project" a sensible sentence, where "ask Recallix about this
--   folder" is not. The scoped chat below is the point of the table; the
--   grouping is how it knows what to read.
--
-- WHY ONE PROJECT PER MEETING RATHER THAN MANY
--   Recallix already has a many-to-many way to label a meeting — tags, on the
--   meeting itself, filterable in search. A second one would leave two answers
--   to "how do I group these", and the tree in the product would have to draw a
--   meeting under three parents at once. So a project is a home: exactly one, or
--   none. A meeting that belongs to two things is what tags are for.
--
-- WHY NO NESTING
--   No parent_id, deliberately. Sub-projects buy a hierarchy nobody in a
--   single-person workspace is deep enough to need, and cost a recursive read on
--   every list, a move-loop check on every rename, and a UI that has to explain
--   what happens to children when a parent is deleted. Flat is the whole of what
--   the product needs and none of that.
--
-- WHY THE MEETING FK IS `ON DELETE SET NULL`
--   Deleting a project must never delete recordings. Someone tidying up their
--   sidebar is not asking to destroy six hours of audio and every summary,
--   commitment and highlight attached to it. The meetings survive, unfiled.
--
-- WHY THE CONVERSATION FK IS `ON DELETE CASCADE`
--   The opposite call, for the opposite reason. A conversation about a project
--   is only meaningful inside it: with the project gone, the thread is a set of
--   answers about meetings that are no longer grouped, filed under a scope that
--   no longer exists and reachable from nowhere in the UI.

CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- What the project is for, shown under its name. Optional, because being
    -- made to describe "Client ABC" before you can file anything in it is the
    -- kind of friction that stops people filing anything.
    description TEXT NOT NULL DEFAULT '',
    -- One of a fixed palette, chosen by the UI. Stored as a name rather than a
    -- hex value so it can follow the theme instead of fighting it.
    color       TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_projects_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_projects_description CHECK (length(description) <= 500)
);

-- Two projects with the same name are always a mistake: the name is the only
-- thing distinguishing them in a sidebar, so the second one is either a typo or
-- a duplicate somebody is about to file half their meetings into. Case- and
-- space-insensitive, because "Client ABC" and "client abc " are the same claim.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_user_name
    ON projects (user_id, lower(btrim(name)));

ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects (id) ON DELETE SET NULL;

-- The project page's read: this project's meetings, newest first.
CREATE INDEX IF NOT EXISTS idx_meetings_project
    ON meetings (project_id, created_at DESC);

-- --------------------------------------------------------------------------
-- Chat at a third scope
-- --------------------------------------------------------------------------
-- V28 gave conversations two scopes, distinguished by whether meeting_id was
-- set. A third one cannot be squeezed into that same column, so it gets its own:
-- a conversation now has a meeting, or a project, or neither, and neither is the
-- workspace.
--
-- The messages are deliberately left alone. `chat_messages.meeting_id` predates
-- conversations and is only meaningful for the meeting scope; everything reads
-- turns through `conversation_id` now, and the conversation is what carries the
-- scope. Adding a project_id to the messages too would be a second copy of the
-- same fact, kept in step by hand.
ALTER TABLE chat_conversations
    ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_chat_conversations_project
    ON chat_conversations (user_id, project_id, updated_at DESC);

-- A conversation belongs to exactly one scope. Without this, a row with both a
-- meeting and a project would be read as a meeting thread by one query and a
-- project thread by another, and would appear in both histories.
ALTER TABLE chat_conversations
    DROP CONSTRAINT IF EXISTS ck_chat_conversations_one_scope;
ALTER TABLE chat_conversations
    ADD CONSTRAINT ck_chat_conversations_one_scope
    CHECK (meeting_id IS NULL OR project_id IS NULL);

-- --------------------------------------------------------------------------
-- Row-Level Security (see V9)
-- --------------------------------------------------------------------------
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON projects;
-- Ownership is the only test: V11 dropped app_is_system(), and the system
-- exemption is BYPASSRLS on the recallix_sys connection.
CREATE POLICY tenant_isolation ON projects
    FOR ALL
    USING      (user_id = app_current_user())
    WITH CHECK (user_id = app_current_user());

COMMENT ON TABLE projects IS
    'A body of work a meeting belongs to. One per meeting; tags remain the many-to-many.';
COMMENT ON COLUMN meetings.project_id IS
    'The project this meeting is filed under, or NULL for unfiled. SET NULL on delete: removing a project never removes recordings.';
COMMENT ON COLUMN chat_conversations.project_id IS
    'Set for a project-scoped thread. Mutually exclusive with meeting_id; both NULL means the workspace.';
