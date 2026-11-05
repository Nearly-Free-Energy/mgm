-- Gives the objects a logical restore creates in schema public exactly the
-- privileges they had in the source. It writes no data.
--
-- schema.sql sets each object's privileges with GRANT and REVOKE statements
-- written against PostgreSQL's built-in defaults. An object created during
-- the restore also receives the default privileges that the restoring role
-- (postgres) holds in schema public of the target, and a new Supabase project
-- sets its own. This file clears those first, so each table, sequence and
-- function ends with only what schema.sql grants it. schema.sql then sets the
-- source's own default privileges, for objects created later.
--
-- Run it in the restore transaction, after restore-target-preflight.sql and
-- before roles.sql and schema.sql (docs/runbooks/backup-and-restore.md, the
-- logical restore's "Restore the database" step). It does not open or commit
-- a transaction of its own.
--
-- The roles named below are the ones a new Supabase project's default
-- privileges grant to. scripts/tests/test_export_restore_e2e.py compares
-- schema public in a restored target with the source's, privileges included,
-- so if Supabase's defaults start naming another role, that test fails until
-- the role is added here.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
