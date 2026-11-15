-- Converge NFE's production database on the migration chain, part 1 of 2:
-- the enum values 00051 added.
--
-- Production was built from the base migrations, the pilot overlay and
-- selected later files, and never ran 00051. A new enum value cannot be used
-- in the transaction that adds it, so these two run in a file of their own,
-- before 20261114230100 uses them. On a database built from the chain both are
-- no-ops (IF NOT EXISTS).
--
-- No role row uses these values (CLAUDE.md, "Role constants"), so adding them
-- grants nothing. ALTER TYPE ... ADD VALUE cannot be undone.

ALTER TYPE public.user_role       ADD VALUE IF NOT EXISTS 'ems_operator';
ALTER TYPE public.role_scope_type ADD VALUE IF NOT EXISTS 'microgrid';
