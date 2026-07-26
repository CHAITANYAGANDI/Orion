-- Read-only public share links for a single meeting.
--
-- Individual users need to hand a recap to a client or teammate who has no
-- Recallix account. That is a different problem from team workspaces: there is
-- no org, no membership and no login — just an unguessable token that resolves
-- to a redacted view of one meeting, revocable at any time by its owner.
--
-- The transcript is opt-in per share. A summary is usually safe to forward; the
-- full verbatim transcript often is not, so it is excluded unless asked for.

CREATE TABLE IF NOT EXISTS meeting_shares (
    id                 TEXT PRIMARY KEY,
    meeting_id         TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- High-entropy, generated in the application layer; the only credential.
    token              TEXT NOT NULL UNIQUE,
    include_transcript BOOLEAN NOT NULL DEFAULT FALSE,
    -- NULL means the link does not expire on its own.
    expires_at         TIMESTAMPTZ,
    revoked            BOOLEAN NOT NULL DEFAULT FALSE,
    view_count         INTEGER NOT NULL DEFAULT 0,
    last_viewed_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Token lookup is the hot path: every anonymous page view resolves through it.
CREATE INDEX IF NOT EXISTS idx_shares_token ON meeting_shares(token);

-- At most one live link per meeting, so "share" is idempotent and revoking is
-- unambiguous. Revoked rows are retained as an audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_active_meeting
    ON meeting_shares(meeting_id) WHERE NOT revoked;

CREATE INDEX IF NOT EXISTS idx_shares_user ON meeting_shares(user_id, created_at);
