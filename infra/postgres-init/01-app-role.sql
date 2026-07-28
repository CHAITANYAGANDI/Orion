-- The unprivileged role the application connects as.
--
-- Row-level security is ignored entirely by superusers and by any role holding
-- BYPASSRLS — FORCE ROW LEVEL SECURITY does not change that. The bootstrap user
-- created by the Postgres image (`recallix`) is a superuser, so connecting as it
-- leaves every policy in V9 enabled and enforcing nothing: the most dangerous
-- possible state, because it looks secure.
--
-- So there are two roles, with different jobs:
--
--   recallix      owns the schema and runs Flyway. Superuser, needed for
--                 CREATE EXTENSION vector. Never serves a request.
--   recallix_app  what Spring and the ai-service connect as at runtime.
--                 NOSUPERUSER and NOBYPASSRLS, so the policies actually bind.
--
-- Runs automatically on a fresh volume (docker-entrypoint-initdb.d). On a
-- managed database — Neon, RDS — run it once by hand as the owner.

--   recallix_sys  the handful of paths with no user behind them: worker
--                 callbacks, the outbox relay, Stripe webhooks, public share
--                 links, and provisioning during authentication. Holds
--                 BYPASSRLS, so its exemption is a property of the connection.
--
-- The third role is the point of the design. An earlier version expressed the
-- system exemption as a session setting the policies consulted, which meant
-- anything able to run arbitrary SQL could simply switch it on and read every
-- tenant. A privilege carried by the connection cannot be granted by a
-- statement, so injection into an app-role connection stays inside one tenant.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recallix_app') THEN
        CREATE ROLE recallix_app LOGIN PASSWORD 'recallix_app'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recallix_sys') THEN
        CREATE ROLE recallix_sys LOGIN PASSWORD 'recallix_sys'
            NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END $$;

-- Explicitly, in case the roles predate this script or were created by hand.
ALTER ROLE recallix_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE recallix_sys NOSUPERUSER BYPASSRLS   NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO recallix_app, recallix_sys;

-- DML only, for both. Schema changes belong to Flyway, running as the owner,
-- so neither role can drop a policy to escape its tenant — and recallix_sys,
-- despite bypassing RLS, still cannot alter the schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
    TO recallix_app, recallix_sys;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
    TO recallix_app, recallix_sys;

-- Tables created by future migrations, so a new table is not accidentally
-- unreachable until someone remembers to grant on it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO recallix_app, recallix_sys;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO recallix_app, recallix_sys;
