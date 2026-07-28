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

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recallix_app') THEN
        CREATE ROLE recallix_app LOGIN PASSWORD 'recallix_app'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END $$;

-- Explicitly, in case the role predates this script or was created by hand.
ALTER ROLE recallix_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO recallix_app;

-- DML only. Schema changes belong to Flyway, running as the owner, which also
-- means a compromised application cannot drop a policy to escape its tenant.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO recallix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO recallix_app;

-- Tables created by future migrations, so a new table is not accidentally
-- unreachable until someone remembers to grant on it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO recallix_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO recallix_app;
