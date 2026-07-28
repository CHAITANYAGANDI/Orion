-- Remove the forgeable system bypass from every policy.
--
-- V9 let a session exempt itself with `SELECT set_config('app.bypass','on')`.
-- That defended against the bug it was built for — a repository method missing
-- its ownership check — but it did not contain SQL injection: an injected
-- statement could turn the bypass on and read every tenant.
--
-- The exemption is now a property of the CONNECTION instead. System work
-- connects as `recallix_sys`, which holds BYPASSRLS; everything else connects
-- as `recallix_app`, which does not. No statement can grant a role attribute,
-- so injection into an app connection stays inside one tenant.
--
-- app_is_system() is dropped entirely rather than left unused, so nothing can
-- reintroduce a dependency on it later.

-- --------------------------------------------------------------------------
-- Tenant-owned tables: ownership is the only test that remains.
-- --------------------------------------------------------------------------
DO $$
DECLARE
    t text;
    owned text[] := ARRAY[
        'meetings', 'chat_messages', 'commitments', 'decision_links',
        'decision_vectors', 'transcript_chunks', 'calendar_subscriptions',
        'agent_connections', 'agent_action_requests', 'external_sync_logs',
        'meeting_shares', 'subscriptions', 'usage_limits', 'audit_logs'
    ];
BEGIN
    FOREACH t IN ARRAY owned LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation ON %I
                FOR ALL
                USING      (user_id = app_current_user())
                WITH CHECK (user_id = app_current_user())
        $p$, t);
    END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- Tables owned through their meeting.
-- --------------------------------------------------------------------------
DO $$
DECLARE
    t text;
    children text[] := ARRAY[
        'meeting_action_items', 'meeting_decisions', 'meeting_risks',
        'meeting_summaries', 'meeting_transcripts', 'transcript_segments'
    ];
BEGIN
    FOREACH t IN ARRAY children LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation ON %I
                FOR ALL
                USING (EXISTS (
                    SELECT 1 FROM meetings m
                    WHERE m.id = %I.meeting_id AND m.user_id = app_current_user()
                ))
                WITH CHECK (EXISTS (
                    SELECT 1 FROM meetings m
                    WHERE m.id = %I.meeting_id AND m.user_id = app_current_user()
                ))
        $p$, t, t, t);
    END LOOP;
END $$;

DROP POLICY IF EXISTS tenant_isolation ON commitment_evidence;
CREATE POLICY tenant_isolation ON commitment_evidence
    FOR ALL
    USING (EXISTS (
        SELECT 1 FROM commitments c
        WHERE c.id = commitment_evidence.commitment_id
          AND c.user_id = app_current_user()
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM commitments c
        WHERE c.id = commitment_evidence.commitment_id
          AND c.user_id = app_current_user()
    ));

DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
    FOR ALL
    USING      (id = app_current_user())
    WITH CHECK (id = app_current_user());

-- --------------------------------------------------------------------------
-- Outbox: written by user requests, drained only by the relay.
-- --------------------------------------------------------------------------
-- The INSERT policy still admits any configured session. It cannot check
-- ownership — an outbox row is an instruction to the relay, not tenant data —
-- but an unconfigured connection is still refused. Draining now requires
-- BYPASSRLS rather than a settable flag, so a user request cannot enumerate
-- other tenants' meeting ids from the payloads.
DROP POLICY IF EXISTS outbox_enqueue ON outbox_events;
DROP POLICY IF EXISTS outbox_drain ON outbox_events;
DROP POLICY IF EXISTS outbox_mark_published ON outbox_events;
DROP POLICY IF EXISTS outbox_purge ON outbox_events;

CREATE POLICY outbox_enqueue ON outbox_events
    FOR INSERT
    WITH CHECK (app_current_user() IS NOT NULL);

-- No SELECT/UPDATE/DELETE policy at all: with RLS enabled and no permissive
-- policy, those commands match nothing for recallix_app. recallix_sys bypasses
-- policies entirely and drains the queue.

-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_is_system();
