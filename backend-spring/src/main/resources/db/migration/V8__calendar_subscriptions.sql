-- Calendar subscriptions (iCal / ICS).
--
-- Read-only, and deliberately not OAuth. Every calendar provider — Google,
-- Outlook, Apple, Fastmail — publishes a secret iCal URL from its own settings,
-- so one mechanism covers all of them with no app registration, no client
-- secret, and no provider verification review.

CREATE TABLE IF NOT EXISTS calendar_subscriptions (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64)  NOT NULL,
    -- The secret iCal URL. Anyone holding it can read the whole calendar, so
    -- it is never returned to the client — see CalendarSubscriptionResponse,
    -- which exposes only a redacted form.
    url             TEXT         NOT NULL,
    label           VARCHAR(120),
    last_synced_at  TIMESTAMPTZ,
    -- Last failure, kept so the UI can explain a stale calendar rather than
    -- silently showing nothing.
    last_error      TEXT,
    event_count     INTEGER      NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Subscribing to the same calendar twice would double every meeting in the
-- upcoming list.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_subscriptions_user_url
    ON calendar_subscriptions (user_id, url);

CREATE INDEX IF NOT EXISTS idx_calendar_subscriptions_user
    ON calendar_subscriptions (user_id);
