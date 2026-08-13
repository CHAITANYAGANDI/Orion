-- OAuth calendar accounts, and the bots that record their meetings.
--
-- Two features that only make sense together: the calendar tells us a meeting
-- is happening, and the bot is what actually attends it. Neither replaces the
-- existing iCal subscriptions — a user can hold both, and `upcoming` merges
-- them, so nobody has to reconnect anything to keep what already works.

-- --------------------------------------------------------------------------
-- OAuth-connected calendars.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_accounts (
    id                  VARCHAR(64) PRIMARY KEY,
    user_id             VARCHAR(64)  NOT NULL,
    -- 'google' | 'microsoft'. Not an enum: adding a provider should be a code
    -- change and a row, not a migration that locks the table.
    provider            VARCHAR(32)  NOT NULL,
    -- The provider's own account identifier. Together with provider this is
    -- what makes reconnecting the same account an update rather than a
    -- duplicate, so a user who reconnects does not end up with their calendar
    -- listed twice.
    external_account_id TEXT         NOT NULL,
    account_email       TEXT,

    -- AES-256-GCM ciphertext, written by TokenCipher, never plaintext. A
    -- refresh token here is long-lived read access to somebody's whole
    -- calendar; row-level security does not protect a backup or a replica, so
    -- these are encrypted before they reach Postgres.
    access_token_enc    TEXT,
    refresh_token_enc   TEXT,
    -- When the access token dies. Refresh is driven off this rather than off a
    -- failed API call, so an expiring token is renewed before it breaks a sync.
    access_expires_at   TIMESTAMPTZ,

    scopes_json         JSONB        NOT NULL DEFAULT '[]',
    -- Set when a refresh has failed permanently (revoked in the provider's
    -- console, password changed, consent withdrawn). Retrying a revoked grant
    -- forever would just earn rate limits, so this parks the account and the
    -- UI asks the user to reconnect.
    last_error          TEXT,
    last_synced_at      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT calendar_accounts_provider_account_key
        UNIQUE (user_id, provider, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_accounts_user
    ON calendar_accounts(user_id);

COMMENT ON COLUMN calendar_accounts.refresh_token_enc IS
    'AES-256-GCM ciphertext (TokenCipher). Never store or log the plaintext.';

-- --------------------------------------------------------------------------
-- Bots scheduled against calendar events.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_bots (
    id                VARCHAR(64) PRIMARY KEY,
    user_id           VARCHAR(64)  NOT NULL,

    -- The calendar event this bot is for. iCal UIDs are not globally unique
    -- across providers and recurring events repeat theirs, so the occurrence
    -- start time is part of the identity — otherwise toggling "record this
    -- one" on a weekly standup would toggle every instance of it.
    event_uid         TEXT         NOT NULL,
    occurrence_start  TIMESTAMPTZ  NOT NULL,

    -- Denormalised from the calendar so the bot can still be described after
    -- the event is deleted upstream, and so the meeting it creates gets a
    -- title without a second calendar fetch.
    title             TEXT,
    join_url          TEXT         NOT NULL,
    participants_json JSONB        NOT NULL DEFAULT '[]',

    -- The vendor's bot id, once scheduled. Null while PENDING and after a
    -- cancellation that the vendor accepted.
    external_bot_id   TEXT,
    -- PENDING | SCHEDULED | RECORDING | DONE | FAILED | CANCELLED
    status            VARCHAR(24)  NOT NULL DEFAULT 'PENDING',
    last_error        TEXT,

    -- The meeting row this bot's recording became, once it has one.
    meeting_id        VARCHAR(64),

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- One bot per occurrence. Without this, a double-click on the toggle sends
    -- two bots into the same call, and the user is billed for both.
    CONSTRAINT meeting_bots_occurrence_key
        UNIQUE (user_id, event_uid, occurrence_start)
);

CREATE INDEX IF NOT EXISTS idx_meeting_bots_user_start
    ON meeting_bots(user_id, occurrence_start);

-- Webhooks arrive with the vendor's id and no tenant context, so this lookup
-- must be fast and unambiguous. Partial, because external_bot_id is null until
-- the vendor accepts the schedule.
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_bots_external
    ON meeting_bots(external_bot_id) WHERE external_bot_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Default auto-join preference, alongside the existing recap preferences.
-- --------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auto_join_meetings BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN users.auto_join_meetings IS
    'Send a bot to every calendar meeting with a join link, unless turned off '
    'for that occurrence. Default false: opting a user into recording their '
    'meetings is not a default anyone should inherit.';

-- --------------------------------------------------------------------------
-- Row-level security, matching V11's tenant-owned pattern exactly.
-- --------------------------------------------------------------------------
DO $$
DECLARE
    t text;
    owned text[] := ARRAY['calendar_accounts', 'meeting_bots'];
BEGIN
    FOREACH t IN ARRAY owned LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        -- FORCE so the table owner is subject to the policy too; without it
        -- the migration role would silently bypass what this is protecting.
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation ON %I
                FOR ALL
                USING      (user_id = app_current_user())
                WITH CHECK (user_id = app_current_user())
        $p$, t);
    END LOOP;
END $$;

-- No GRANTs here on purpose. infra/postgres-init/01-app-role.sql sets ALTER
-- DEFAULT PRIVILEGES for both roles on tables created later, so these are
-- already reachable. Granting explicitly would also make this migration fail
-- outright on any database where those roles do not exist.
--
-- The bot webhook arrives with no user behind it: it is authenticated by the
-- vendor's signature, finds its row by external_bot_id, and writes the result.
-- That runs on recallix_sys, whose exemption comes from BYPASSRLS on the
-- connection — the same path the outbox relay already uses. Deliberately no
-- policy is added for it, because a policy keyed on anything the request could
-- supply would be forgeable, which is precisely what V11 removed.
