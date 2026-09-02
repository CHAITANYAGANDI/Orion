-- Two corrections to mail_outbox's row-level security. One is why closing an
-- account fails outright; the other is a hole nobody had noticed.
--
-- =========================================================================
-- 1. WHY CLOSING AN ACCOUNT FAILED
-- =========================================================================
--
-- V64 gave this table exactly one policy:
--
--     CREATE POLICY mail_enqueue ON mail_outbox
--         FOR INSERT WITH CHECK (app_current_user() IS NOT NULL);
--
-- and deliberately no SELECT policy at all, reasoning that reading the outbox
-- is the relay's job and an address is not tenant data. That reasoning is
-- sound and the consequence was not foreseen:
--
--     INSERT INTO mail_outbox (...) VALUES (...)
--         ON CONFLICT (dedupe_key) DO NOTHING
--
-- has to look at the conflicting row to decide there is one. With RLS forced
-- and no SELECT policy, the unprivileged role can see nothing, the arbiter
-- has nothing to arbitrate against, and Postgres refuses the statement with
--
--     ERROR: new row violates row-level security policy for table "mail_outbox"
--
-- which reads like a WITH CHECK failure and is not one. Measured directly:
-- with the tenant correctly stamped on the session, a plain INSERT of the very
-- same row SUCCEEDS and the ON CONFLICT form FAILS. That difference is the
-- whole bug.
--
-- It surfaced only on account closure because that is the one message enqueued
-- from a tenant connection. Every other message is written by a scheduled job
-- or an internal callback, both of which run as the system role and hold
-- BYPASSRLS, so no policy was ever consulted. It stayed hidden even then,
-- because AccountMail.write() returns early on a blank address and the address
-- was blank until a Clerk JWT template began sending one.
--
-- =========================================================================
-- 2. THE HOLE
-- =========================================================================
--
-- `WITH CHECK (app_current_user() IS NOT NULL)` asks whether SOMEBODY is
-- signed in. It never asks whose row this is. So any authenticated request
-- could write a mail_outbox row carrying another tenant's user_id -- and the
-- relay, which trusts the table, would deliver it. Nothing in the application
-- does that today; nothing in the database stopped it either.
--
-- =========================================================================
-- THE MODEL THIS SETTLES ON
-- =========================================================================
--
--   INSERT  only a row whose user_id IS the current tenant. The account-closed
--           message satisfies this: it is enqueued by the account holder, for
--           the account holder, inside the transaction doing the deleting --
--           and the comparison is between a column and a session setting, so
--           it holds perfectly well after the users row is gone.
--
--   SELECT  own rows only, and only because ON CONFLICT needs it. This is not
--           the cross-tenant read V64 refused: a tenant sees the address and
--           body of mail addressed to itself, which is its own address and its
--           own message. Every dedupe_key written from a tenant connection
--           embeds that tenant's id, so a conflict is always with its own row
--           and this is sufficient for the arbiter.
--
--   UPDATE / DELETE  still no policy, so still nothing. Delivery state,
--           attempt counts and the retirement of a row remain the relay's
--           alone; a request handler cannot mark its own mail sent, cannot
--           rewrite a recipient, and cannot delete the evidence of a closure.
--
--   The system role is untouched. It holds BYPASSRLS, which is carried by the
--   connection and cannot be granted by a statement, so claiming, retrying and
--   purging work exactly as before.
--
-- Idempotency is preserved and is tested: a second enqueue of the same
-- dedupe_key reports zero rows written rather than raising, which is what
-- stops a retried job from rolling back the transaction it was enqueued in.

DROP POLICY IF EXISTS mail_enqueue ON mail_outbox;
CREATE POLICY mail_enqueue ON mail_outbox
    FOR INSERT
    WITH CHECK (user_id IS NOT NULL AND user_id = app_current_user());

DROP POLICY IF EXISTS mail_own ON mail_outbox;
CREATE POLICY mail_own ON mail_outbox
    FOR SELECT
    USING (user_id IS NOT NULL AND user_id = app_current_user());
