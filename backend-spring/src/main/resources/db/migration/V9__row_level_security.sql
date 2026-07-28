-- Row-Level Security: tenant isolation enforced by Postgres, not by convention.
--
-- Until now every ownership check lived in application code — `findByIdAndUserId`
-- and a `require(userId, meetingId)` call at the top of each service method.
-- That works, but it is a convention: one repository method that takes only a
-- meetingId, called from a new endpoint that forgets the ownership check, is a
-- silent cross-tenant leak that nothing in the build would catch.
--
-- After this migration the database itself refuses to return another tenant's
-- rows, so an application bug becomes an empty result instead of a breach.
--
-- HOW IT WORKS
--   Two settings are established on every pooled connection at checkout:
--     app.user_id  the authenticated user, or '' when there is none
--     app.bypass   'on' only for genuine system work (see below)
--   Both default to fail-closed: an unset app.user_id matches no rows at all,
--   so forgetting to set it denies access rather than granting it.
--
-- WHY FORCE
--   Postgres exempts a table's owner from its own RLS policies. Both this app
--   and Flyway connect as the owner, so without FORCE every policy here would
--   be silently inert — the most dangerous possible outcome, since it looks
--   secure and enforces nothing.
--
-- FUTURE MIGRATIONS
--   DDL is unaffected, but any migration that moves DATA between rows must
--   begin with:  SELECT set_config('app.bypass', 'on', true);
--   otherwise its UPDATE/INSERT will silently match zero rows.

-- --------------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------------

-- STABLE, not IMMUTABLE: the value changes between statements in a session.
-- `true` as the second argument to current_setting means "return NULL if the
-- setting is missing" rather than raising, which is what makes an unconfigured
-- connection fail closed instead of erroring.
CREATE OR REPLACE FUNCTION app_current_user() RETURNS text
    LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;

-- System context: the small number of paths that legitimately have no user.
-- Internal worker callbacks (keyed by meeting, not user), the outbox relay,
-- Stripe webhooks, public share-link resolution, and user provisioning during
-- authentication — which necessarily runs before the tenant is known.
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean
    LANGUAGE sql STABLE
AS $$ SELECT coalesce(current_setting('app.bypass', true), 'off') = 'on' $$;

-- --------------------------------------------------------------------------
-- Tables owned directly by a user (they carry user_id)
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
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        -- FOR ALL covers SELECT/UPDATE/DELETE via USING and INSERT/UPDATE via
        -- WITH CHECK, so a tenant can neither read nor write another's rows.
        EXECUTE format($p$
            CREATE POLICY tenant_isolation ON %I
                FOR ALL
                USING      (app_is_system() OR user_id = app_current_user())
                WITH CHECK (app_is_system() OR user_id = app_current_user())
        $p$, t);
    END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- Tables owned through their meeting
-- --------------------------------------------------------------------------
-- These carry meeting_id rather than user_id. The ownership test is an EXISTS
-- against meetings, which is a primary-key lookup — cheap enough that
-- denormalising user_id onto six more tables was not worth the backfill risk.
-- (transcript_chunks is the exception and already carries user_id: vector
-- search filters on it inside the index scan, where a subquery would not help.)
DO $$
DECLARE
    t text;
    children text[] := ARRAY[
        'meeting_action_items', 'meeting_decisions', 'meeting_risks',
        'meeting_summaries', 'meeting_transcripts', 'transcript_segments'
    ];
BEGIN
    FOREACH t IN ARRAY children LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation ON %I
                FOR ALL
                USING (
                    app_is_system() OR EXISTS (
                        SELECT 1 FROM meetings m
                        WHERE m.id = %I.meeting_id
                          AND m.user_id = app_current_user()
                    )
                )
                WITH CHECK (
                    app_is_system() OR EXISTS (
                        SELECT 1 FROM meetings m
                        WHERE m.id = %I.meeting_id
                          AND m.user_id = app_current_user()
                    )
                )
        $p$, t, t, t);
    END LOOP;
END $$;

-- Evidence hangs off a commitment, which carries user_id.
ALTER TABLE commitment_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE commitment_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON commitment_evidence;
CREATE POLICY tenant_isolation ON commitment_evidence
    FOR ALL
    USING (
        app_is_system() OR EXISTS (
            SELECT 1 FROM commitments c
            WHERE c.id = commitment_evidence.commitment_id
              AND c.user_id = app_current_user()
        )
    )
    WITH CHECK (
        app_is_system() OR EXISTS (
            SELECT 1 FROM commitments c
            WHERE c.id = commitment_evidence.commitment_id
              AND c.user_id = app_current_user()
        )
    );

-- --------------------------------------------------------------------------
-- Special cases
-- --------------------------------------------------------------------------

-- A user may see only their own row. Provisioning looks users up by
-- clerk_user_id *before* the tenant is known, so it runs in system context.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
    FOR ALL
    USING      (app_is_system() OR id = app_current_user())
    WITH CHECK (app_is_system() OR id = app_current_user());

-- Infrastructure, never touched by a user request. System context only, which
-- also means an application bug cannot read the event stream as a tenant.
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON outbox_events;
CREATE POLICY tenant_isolation ON outbox_events
    FOR ALL
    USING (app_is_system())
    WITH CHECK (app_is_system());

-- --------------------------------------------------------------------------
-- Supporting indexes
-- --------------------------------------------------------------------------
-- The child-table policies filter through meetings.id, which is already the
-- primary key. These cover the direct-ownership policies, whose predicate is
-- user_id on every access rather than only on the queries that name it.
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_external_sync_logs_user ON external_sync_logs (user_id);
