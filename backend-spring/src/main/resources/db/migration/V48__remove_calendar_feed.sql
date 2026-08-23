-- Remove the deadline calendar feed.
--
-- V36 added `users.calendar_token`: the secret path segment of an ICS feed of
-- action item deadlines, published at /public/calendar/{token}.ics and fetched
-- by Google's or Apple's servers with no session and no header we could add.
-- The URL was the credential.
--
-- The feature is gone, and this is the part of it that cannot be deleted by
-- deleting a file. Every one of those tokens is a live, unauthenticated read of
-- somebody's deadlines, and any subscription still pointing at one now gets a
-- 404 from a route that no longer exists -- so leaving the column would keep a
-- credential on every account that ever enabled a feed while nothing could
-- honour it. Dropping it is the revocation.
--
-- Nothing reads these columns any more: `IntegrationsController`,
-- `CalendarFeedService` and the `calendarToken` fields on `UserEntity` were
-- deleted in the same change. Irreversible, deliberately -- restoring the
-- column would not restore the tokens, and issuing new ones is what enabling a
-- feed did.
--
-- V17 and V18 are the earlier round trip on this: V8 added
-- `calendar_subscriptions` for *reading* a user's calendar over OAuth, V17
-- widened it, and V18 removed the lot. Row level security needs no attention
-- here -- the policies on `users` are on `id`, not on any column below.

DROP INDEX IF EXISTS uq_users_calendar_token;

ALTER TABLE users
    DROP COLUMN IF EXISTS calendar_token,
    DROP COLUMN IF EXISTS calendar_token_created_at;
