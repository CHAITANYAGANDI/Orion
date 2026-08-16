-- What a share link is allowed to reveal, who can open it, and how much of the
-- meeting it points at.
--
-- V5 gave a link one dial: transcript, yes or no. Everything else — summary,
-- action items — was always included and the recording never was. That is one
-- policy for every recipient, and it is wrong in both directions: a client who
-- should see the decisions should not necessarily see who was assigned what,
-- and somebody being sent a recording to verify a quote cannot be.
--
-- WHY FOUR BOOLEANS RATHER THAN A ROLE
--   Roles are the obvious model and the wrong one here. "Viewer", "commenter",
--   "editor" describe what a person may *do*, which presumes there is a person:
--   an account to attribute a comment to and to check on the next request. A
--   share link has no account behind it — it is a capability URL, and everyone
--   holding it is the same anonymous reader. What can vary is not permission but
--   content, so the dials say what is visible rather than who may act.
--
-- WHY THE AUDIO DEFAULTS OFF, LIKE THE TRANSCRIPT
--   Same reason, more so. A summary is a written account somebody can stand
--   behind; the recording is everyone's unedited voice, including the parts
--   nobody would have written down. Opt-in, always.
--
-- WHY A PASSWORD WHEN THE TOKEN IS ALREADY 192 BITS
--   The token is unguessable but it is not undisclosable. It travels through
--   mail, chat and calendar invites, gets forwarded, and survives in the history
--   of every one of them. A password is the second factor for a link that has
--   leaked but not yet been noticed — and it is the only control that helps
--   *after* the URL is somewhere it should not be, since revoking requires
--   knowing.
--
--   Stored as a bcrypt hash. Not because a share password is a login credential
--   worth much on its own, but because people reuse passwords, and a plaintext
--   column here would be a plaintext column of other systems' passwords. The
--   work factor doubles as the rate limit: at roughly a tenth of a second per
--   attempt, guessing is not a strategy.

ALTER TABLE meeting_shares
    ADD COLUMN IF NOT EXISTS include_summary      BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS include_action_items BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS include_audio        BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS password_hash        TEXT,
    -- A label for the owner's own list. Three links to the same meeting are
    -- otherwise three identical rows of random characters.
    ADD COLUMN IF NOT EXISTS label                TEXT NOT NULL DEFAULT '';

-- --------------------------------------------------------------------------
-- Sharing one moment rather than the meeting
-- --------------------------------------------------------------------------
-- NULL start means the whole meeting, which is what every existing row is.
-- A range narrows the link to an excerpt: the transcript is clipped to it and
-- the player, if audio is shared at all, opens and stops there.
--
-- This is the piece that made the one-link-per-meeting rule too strict. V5
-- enforced a single live link so that pressing Share twice could not mint a
-- second URL the owner would never see again — a good rule for the meeting, and
-- an impossible one for moments, since the whole point is several excerpts
-- shared with different people. So the uniqueness now applies only to
-- whole-meeting links: at most one of those, and as many moment links as there
-- are moments, each revocable on its own.
ALTER TABLE meeting_shares
    ADD COLUMN IF NOT EXISTS start_seconds DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS end_seconds   DOUBLE PRECISION,
    -- The words the moment was made from, denormalised the same way and for the
    -- same reason as transcript_moments.quote: the segments behind it can be
    -- edited or replaced by a reprocess, and a link that silently starts
    -- quoting different words is worse than one that shows what was shared.
    ADD COLUMN IF NOT EXISTS quote         TEXT NOT NULL DEFAULT '';

ALTER TABLE meeting_shares
    DROP CONSTRAINT IF EXISTS ck_meeting_shares_range;
ALTER TABLE meeting_shares
    ADD CONSTRAINT ck_meeting_shares_range
    CHECK (
        (start_seconds IS NULL AND end_seconds IS NULL)
        OR (start_seconds IS NOT NULL AND end_seconds IS NOT NULL
            AND end_seconds >= start_seconds)
    );

DROP INDEX IF EXISTS idx_shares_active_meeting;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_active_meeting
    ON meeting_shares (meeting_id)
    WHERE NOT revoked AND start_seconds IS NULL;

-- The dialog lists every live link for a meeting, newest first.
CREATE INDEX IF NOT EXISTS idx_shares_meeting_live
    ON meeting_shares (meeting_id, created_at DESC)
    WHERE NOT revoked;

COMMENT ON COLUMN meeting_shares.password_hash IS
    'bcrypt hash, or NULL for an unprotected link. The work factor is also the rate limit.';
COMMENT ON COLUMN meeting_shares.start_seconds IS
    'NULL for a whole-meeting link. Set together with end_seconds to share one excerpt.';
