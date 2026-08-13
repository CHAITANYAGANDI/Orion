-- Remove the calendar feature entirely.
--
-- Three things go at once, because they were one feature wearing three hats:
--
--   calendar_subscriptions  read-only iCal sync (V8), the part that shipped
--   calendar_accounts       Google/Microsoft OAuth accounts (V17)
--   meeting_bots            bots scheduled against calendar events (V17)
--
-- V17 stays in history rather than being deleted. It ran, so Flyway has its
-- checksum; removing the file would fail validation on every database that
-- applied it. Same reason V4 still creates tables that V15 drops.
--
-- The OAuth tables never carried real data — no provider credentials were ever
-- configured, so no token was ever written and no bot was ever scheduled. The
-- iCal table may hold subscriptions, and those go with it: the feature that
-- read them no longer exists, and a secret iCal URL is not something to keep
-- sitting in a table nothing reads.

DROP TABLE IF EXISTS meeting_bots;
DROP TABLE IF EXISTS calendar_accounts;
DROP TABLE IF EXISTS calendar_subscriptions;

-- Added by V17 for the auto-join preference. Nothing reads it now.
ALTER TABLE users
    DROP COLUMN IF EXISTS auto_join_meetings;
