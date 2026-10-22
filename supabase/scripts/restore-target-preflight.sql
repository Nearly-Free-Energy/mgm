-- Stops a logical restore unless its target is empty. It writes nothing.
--
-- A logical restore (docs/runbooks/backup-and-restore.md) loads an export
-- into a new project. The runbook runs this file twice: on its own when it
-- confirms the target, before any export is decrypted, and as the first file
-- of the restore transaction, so a target that changed in between still
-- stops the restore before anything is written. It does not open or commit a
-- transaction of its own.
--
-- A new Supabase project has no tables in schema public and no Auth users. A
-- database with either is not a restore target: most likely it is the source,
-- or another live environment, reached through the wrong connection. Any
-- table in schema public, or any row in the tables listed below, refuses the
-- target. The list names tables a live MGM database is never without, so the
-- error says why the target looks live. The check on schema public does not
-- depend on it: a listed table that a migration renames or drops is skipped
-- without weakening the check (scripts/tests/test_restore_target_preflight.py
-- fails when that happens, so the list stays current).

DO $preflight$
DECLARE
  live_tables CONSTANT text[] := ARRAY[
    'public.organizations',
    'public.billing_periods',
    'public.billing_line_items',
    'public.payment_merchant_accounts',
    'auth.users'
  ];
  table_name text;
  relation regclass;
  row_count bigint;
  public_tables text;
  problems text[] := ARRAY[]::text[];
BEGIN
  FOREACH table_name IN ARRAY live_tables LOOP
    relation := to_regclass(table_name);
    CONTINUE WHEN relation IS NULL;
    EXECUTE format('SELECT count(*) FROM %s', relation) INTO row_count;
    IF row_count > 0 THEN
      problems := problems || format('rows in %s: %s', table_name, row_count);
    END IF;
  END LOOP;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO public_tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p');
  IF public_tables IS NOT NULL THEN
    problems := problems || format('schema public already has tables: %s', public_tables);
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'restore target is not empty; nothing was restored'
      USING DETAIL = array_to_string(problems, E'\n'),
            HINT = 'Check that the connection reaches the new target project and not the source '
                   'or another live environment. A logical restore needs a new, empty project.';
  END IF;

  RAISE NOTICE 'restore target is empty: no tables in schema public and no Auth users';
END
$preflight$;
