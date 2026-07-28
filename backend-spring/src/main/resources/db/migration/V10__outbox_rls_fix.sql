-- Correct the outbox policy from V9.
--
-- V9 restricted outbox_events to system context on the assumption that only the
-- relay touches it. That was wrong in one direction: the relay *reads and
-- marks* events, but they are *written* by ordinary user requests — creating a
-- meeting enqueues `meeting_uploaded` inside the same transaction, which is the
-- whole point of an outbox. The blanket policy therefore broke every upload,
-- import and reprocess with "new row violates row-level security policy".
--
-- Split by command instead:
--
--   INSERT  any legitimate session, user or system. The row carries no user_id
--           to check against — an outbox entry is a instruction to the relay,
--           not tenant data — so the test is only that a session exists at all,
--           which still refuses an unconfigured connection.
--
--   SELECT / UPDATE / DELETE  system only. Draining the queue is the relay's
--           job; no user request has any reason to read the event stream, and
--           denying it means an application bug cannot enumerate other tenants'
--           meeting ids from the payloads.

DROP POLICY IF EXISTS tenant_isolation ON outbox_events;

CREATE POLICY outbox_enqueue ON outbox_events
    FOR INSERT
    WITH CHECK (app_is_system() OR app_current_user() IS NOT NULL);

CREATE POLICY outbox_drain ON outbox_events
    FOR SELECT
    USING (app_is_system());

CREATE POLICY outbox_mark_published ON outbox_events
    FOR UPDATE
    USING (app_is_system())
    WITH CHECK (app_is_system());

CREATE POLICY outbox_purge ON outbox_events
    FOR DELETE
    USING (app_is_system());
