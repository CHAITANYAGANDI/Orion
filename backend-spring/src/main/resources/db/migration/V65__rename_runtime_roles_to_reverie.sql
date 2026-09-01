-- Renames the two runtime roles from orion_* to reverie_*, following the
-- product rename. This is the same operation V62 performed for recallix_* ->
-- orion_*, and the reasoning below is unchanged from it because none of the
-- constraints have changed.
--
-- WHY THIS IS A MIGRATION AND NOT AN EDIT
--
-- The roles are named in the comments of a dozen earlier migrations, and those
-- are left exactly as they were -- including V62, which names the rename this
-- one supersedes. Flyway checksums every applied migration and validates them
-- on start-up, so changing one byte of V11 or V62 -- even inside a comment --
-- makes the backend refuse to boot against a database that has already run it.
-- Those files are a record of what was done, not a description of what is true
-- now; read them as history and read this file for the current names.
--
-- WHY A RENAME AND NOT CREATE-AND-DROP
--
-- Postgres stores privileges and policy membership by role OID, not by name.
-- ALTER ROLE ... RENAME TO therefore carries every GRANT, every default
-- privilege, and -- the one that matters -- every row-level security policy
-- across with it, atomically. Creating new roles and re-granting would mean
-- reproducing the whole of V9's policy set by hand, and the failure mode of
-- getting that subtly wrong is a tenant boundary that no longer holds while
-- everything still appears to work.
--
-- The BYPASSRLS attribute on the system role travels with the rename too, which
-- is the property the security model rests on: it is carried by the connection
-- and cannot be granted by a statement.
--
-- ON PASSWORDS
--
-- A rename preserves a SCRAM-SHA-256 password, because the SCRAM verifier is
-- salted with random bytes rather than with the role name. It would NOT
-- preserve a legacy MD5 password, which is salted with the username -- Postgres
-- clears it and the role can no longer log in. Neon issues SCRAM credentials,
-- so this is safe here; on a server still using MD5, reset both passwords
-- immediately after this runs.
--
-- IDEMPOTENT, IN BOTH DIRECTIONS
--
-- A fresh database never has the old roles: infra/postgres-init/01-app-role.sql
-- now creates reverie_app and reverie_sys directly, so the guards below find
-- nothing to do and this migration is a no-op. An existing database has the old
-- names and gets renamed once. Re-running is safe either way.
--
-- ORDERING, AND THE ONE THING THE OPERATOR MUST GET RIGHT
--
-- Flyway runs on its own connection as the schema owner, and the application's
-- Hikari pools are built lazily -- they open no connection until the first
-- query, which is after migration. So the pool that authenticates as
-- reverie_app never races the statement that creates that name, and the
-- correct deploy is a single one: ship this migration and the renamed
-- SPRING_DATASOURCE_USERNAME / REVERIE_DATASOURCE_SYSTEM_USERNAME together.
--
-- Deploying the renamed environment variables WITHOUT this migration is the
-- failure to avoid: Flyway would have nothing to rename, and the pool would
-- then try to authenticate as a role that does not exist.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orion_app')
       AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reverie_app') THEN
        ALTER ROLE orion_app RENAME TO reverie_app;
        RAISE NOTICE 'Renamed role orion_app to reverie_app.';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orion_sys')
       AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reverie_sys') THEN
        ALTER ROLE orion_sys RENAME TO reverie_sys;
        RAISE NOTICE 'Renamed role orion_sys to reverie_sys.';
    END IF;
END $$;

-- DELIBERATELY NOTHING ELSE.
--
-- V62 learned this the hard way and the lesson still applies. An earlier draft
-- of that migration also restated the role attributes -- ALTER ROLE reverie_app
-- NOSUPERUSER NOBYPASSRLS ... -- as cheap belt-and-braces. It is not cheap, and
-- it failed on the first run against Neon:
--
--   ERROR: permission denied to alter role
--   Detail: Only roles with the SUPERUSER attribute may change the SUPERUSER
--           attribute.
--
-- Migrations run as the schema owner, which on a managed Postgres is not a
-- superuser -- neondb_owner holds CREATEROLE and BYPASSRLS and nothing more.
-- Naming NOSUPERUSER is itself an attempt to change the SUPERUSER attribute,
-- even when the role already has it unset and the statement would be a no-op.
--
-- The assertion was redundant anyway. A rename carries every attribute across
-- untouched, so there is nothing here that needs restating. Where the
-- attributes genuinely are decided is infra/postgres-init/01-app-role.sql,
-- which is documented to run as the owner on a fresh database and is the one
-- place that should be setting them.
