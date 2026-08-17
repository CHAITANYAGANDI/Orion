-- Two account-level defaults: what a new share link reveals, and how far back
-- the workspace chat reads.
--
-- WHY SHARING DEFAULTS BELONG ON THE ACCOUNT
--   Every share link already carries its own four flags and its own expiry, and
--   the defaults for a fresh link were constants in Java: summary and action
--   items yes, transcript and recording no, no expiry. Those are good defaults
--   and they are somebody else's opinion. A person who never wants a recording
--   leaving their account should not have to remember to untick it on every
--   link, and a person sharing raw transcripts all day should not have to tick
--   it every time. The per-link controls are unchanged — this is only what the
--   box is set to before they touch it.
--
--   `share_expiry_days` NULL means "never", which is what every link did before
--   this existed and therefore the only default that cannot start expiring
--   links somebody is relying on. Setting it changes new links only: rewriting
--   the expiry of links already sent would revoke access nobody agreed to
--   revoke.
--
-- WHY THE CHAT WINDOW IS A DEFAULT AND NOT A FILTER ON THE DATA
--   `chat_history_days` bounds how far back retrieval reaches for the workspace
--   chat. NULL means every meeting, which is the existing behaviour. It is a
--   scope control rather than a privacy boundary — nothing is hidden, deleted or
--   made unreadable, and the meeting's own page still answers about it — so it
--   is stored here and applied at query time rather than being enforced by RLS.
--
--   It deliberately does not bound the commitment ledger. Open action items are
--   the complete record of what is outstanding, and a task from a meeting last
--   March is still owed; dropping it because the transcript is out of window
--   would make the chat confidently wrong about what is left rather than merely
--   shallower.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS share_include_summary      BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS share_include_action_items BOOLEAN NOT NULL DEFAULT TRUE,
    -- Off, matching the constants they replace. A transcript is every word
    -- somebody said and a recording is their voice; neither should leave an
    -- account because a box was already ticked.
    ADD COLUMN IF NOT EXISTS share_include_transcript   BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS share_include_audio        BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS share_expiry_days          INTEGER,
    ADD COLUMN IF NOT EXISTS chat_history_days          INTEGER;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS ck_users_share_expiry_days,
    DROP CONSTRAINT IF EXISTS ck_users_chat_history_days;

ALTER TABLE users
    -- The same bound as ShareCreateRequest.expiresInDays, so a default cannot
    -- be set that the per-link validator would refuse.
    ADD CONSTRAINT ck_users_share_expiry_days
        CHECK (share_expiry_days IS NULL OR share_expiry_days BETWEEN 1 AND 365),
    -- Ten years, the same ceiling as the retention policy in V35.
    ADD CONSTRAINT ck_users_chat_history_days
        CHECK (chat_history_days IS NULL OR chat_history_days BETWEEN 1 AND 3650);

COMMENT ON COLUMN users.share_expiry_days IS
    'Expiry applied to NEW share links. NULL means never. Existing links are not rewritten.';
COMMENT ON COLUMN users.chat_history_days IS
    'How far back workspace chat retrieves transcripts. NULL means every meeting. Not a privacy boundary.';
