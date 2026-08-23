-- Remove sharing.
--
-- A share link was a token in `meeting_shares` that made one meeting readable
-- at /public/shared/{token}, optionally password-protected, optionally expiring,
-- with four flags choosing how much of the meeting it revealed. It is gone: the
-- controller, the service, the public page, the four account-level defaults and
-- the notification that fired when somebody opened one.
--
-- Dropping the table is the point rather than a tidy-up. Every row in it is a
-- live credential -- the token IS the access check, exactly as the calendar
-- feed's was in V48 -- and a route that no longer exists does not revoke
-- anything. While these rows sit here they are unreachable but not withdrawn,
-- and a future build that restores any read path over this table silently
-- republishes every meeting anybody ever shared. Deleting them is the
-- revocation.
--
-- Irreversible, deliberately. Restoring the table would not restore the links:
-- whoever holds one holds a URL, and the only thing that ever made it work was
-- the row.
--
-- The five columns on `users` are the account-level defaults for a *new* link
-- (V39) and the switch for the "conversation shared" email. Nothing can create
-- a link now, so they are settings for an act that cannot happen.
--
-- `share_opened_email` also leaves `NotificationKind.SHARE_VIEWED` with nothing
-- to emit it; that enum constant went in the same change. Existing
-- notification rows carrying it are left alone -- they are a record of
-- something that did happen, and `NotificationKind.find` already returns empty
-- for a value it does not know rather than throwing.

DROP TABLE IF EXISTS meeting_shares;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS ck_users_share_expiry_days;

ALTER TABLE users
    DROP COLUMN IF EXISTS share_include_summary,
    DROP COLUMN IF EXISTS share_include_action_items,
    DROP COLUMN IF EXISTS share_include_transcript,
    DROP COLUMN IF EXISTS share_include_audio,
    DROP COLUMN IF EXISTS share_expiry_days,
    DROP COLUMN IF EXISTS share_opened_email;
