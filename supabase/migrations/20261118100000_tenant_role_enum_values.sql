-- Tenant app (RFC mgm#197, PR 1), part 1 of 2: the enum values for the
-- tenant role. A tenant's access is a user_roles row
-- (user_id, 'tenant', 'tenant', tenants.id), one per unit the person rents.
--
-- Why this is a file of its own: Postgres refuses to use a new enum value in
-- the transaction that added it ("unsafe use of new value"), and the next
-- migration (20261118100100) uses both values in a generated column, a CHECK,
-- policies and function bodies. 00051 and 20261114230000 are the precedent.
--
-- Inert on their own: nothing can insert a tenant row until the next file
-- installs the grant function. authenticated has only SELECT and DELETE on
-- user_roles, and fn_finalize_user_invitation and fn_change_user_role accept
-- only the staff roles, so a database that stops between the two files
-- behaves as it did before.
--
-- ALTER TYPE ... ADD VALUE cannot be undone: a rollback past this file
-- leaves both values in place, unused. IF NOT EXISTS makes a re-run a no-op.

ALTER TYPE public.user_role       ADD VALUE IF NOT EXISTS 'tenant';
ALTER TYPE public.role_scope_type ADD VALUE IF NOT EXISTS 'tenant';
