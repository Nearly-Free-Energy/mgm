-- Read-only check before applying 20261116230000_rename_households_to_tenants.sql.
--
-- The migration renames objects by name and replaces eight function bodies
-- with the chain's, renamed. On a database that differs from the chain it
-- would stop halfway through its transaction (a missing or already-taken
-- name) or replace a body the chain does not have. This finds either before
-- the window, and changes nothing:
--
--   supabase db query --remote=<production ref> --read-only \
--     -f supabase/scripts/preflight-tenant-rename.sql
--
-- It passes by printing one row, "preflight passed", and fails with an
-- error listing every difference. It checks that:
--   * no tenant object the migration creates exists yet;
--   * every table, column, enum, constraint, index, trigger and policy the
--     migration renames exists, on the table it expects;
--   * the eight functions it replaces exist with the chain's bodies (MD5 of
--     the source), and the two it drops and creates again have the grants
--     it gives them back;
--   * no other function or view names households, so nothing is left behind;
--   * the migration is not in the history yet.
--
-- The expected bodies are the chain's after 20261116210000, the migration
-- before this one. If a later migration changes one of these functions
-- before this one reaches a database, the check fails for that function:
-- compare the bodies, and update this file and the migration together.

DO $$
DECLARE
  problems TEXT[] := '{}';
  item RECORD;
  found_count INTEGER;
BEGIN
  -- Names the migration creates must be free.
  FOR item IN
    SELECT unnest(ARRAY[
      'tenants', 'tenant_devices', 'tenant_users',
      'tenants_pkey', 'tenant_devices_pkey', 'tenant_devices_primary_no_overlap', 'tenant_users_pkey',
      'idx_tenants_microgrid_id', 'idx_tenant_devices_device', 'idx_tenant_devices_tenant',
      'idx_tenant_users_tenant', 'idx_tenant_users_user',
      'idx_billing_line_items_tenant', 'idx_billing_line_items_period_tenant'
    ]) AS name
  LOOP
    IF to_regclass('public.' || item.name) IS NOT NULL THEN
      problems := problems || format('public.%s already exists', item.name);
    END IF;
  END LOOP;
  IF to_regtype('public.tenant_device_role') IS NOT NULL THEN
    problems := problems || 'type public.tenant_device_role already exists'::TEXT;
  END IF;
  SELECT count(*) INTO found_count FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('fn_create_tenant', 'fn_create_tenant_with_meter',
                    'fn_tenant_device_no_overlap', 'fn_replace_tenant_device');
  IF found_count > 0 THEN
    problems := problems || 'a function named fn_*tenant* already exists'::TEXT;
  END IF;

  -- Tables, columns and the enum the migration renames.
  FOR item IN
    SELECT * FROM (VALUES
      ('households', NULL), ('household_devices', NULL), ('household_users', NULL),
      ('household_devices', 'household_id'), ('household_users', 'household_id'),
      ('billing_line_items', 'household_id'), ('pilot_import_batches', 'household_count')
    ) AS t(rel, col)
  LOOP
    IF to_regclass('public.' || item.rel) IS NULL THEN
      problems := problems || format('table public.%s is missing', item.rel);
    ELSIF item.col IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass('public.' || item.rel)
        AND attname = item.col AND attnum > 0 AND NOT attisdropped
    ) THEN
      problems := problems || format('column public.%s.%s is missing', item.rel, item.col);
    END IF;
  END LOOP;
  IF to_regtype('public.household_device_role') IS NULL THEN
    problems := problems || 'type public.household_device_role is missing'::TEXT;
  END IF;

  -- Constraints, on the table each is renamed on.
  FOR item IN
    SELECT * FROM (VALUES
      ('households', 'households_pkey'),
      ('households', 'households_microgrid_id_fkey'),
      ('households', 'households_account_number_shape'),
      ('households', 'households_customer_type_enum'),
      ('households', 'households_meter_serial_shape'),
      ('households', 'households_meter_type_shape'),
      ('household_devices', 'household_devices_pkey'),
      ('household_devices', 'household_devices_household_id_fkey'),
      ('household_devices', 'household_devices_device_id_fkey'),
      ('household_devices', 'household_devices_effective_period_valid'),
      ('household_devices', 'household_devices_primary_no_overlap'),
      ('household_users', 'household_users_pkey'),
      ('household_users', 'household_users_household_id_fkey'),
      ('household_users', 'household_users_user_id_fkey'),
      ('billing_line_items', 'billing_line_items_household_id_fkey'),
      ('pilot_import_batches', 'pilot_import_batches_household_count_check')
    ) AS t(rel, con)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.' || item.rel) AND conname = item.con
    ) THEN
      problems := problems || format('constraint %s on public.%s is missing', item.con, item.rel);
    END IF;
  END LOOP;

  -- Indexes that are not constraints.
  FOR item IN
    SELECT unnest(ARRAY[
      'idx_households_microgrid_id', 'idx_household_devices_device', 'idx_household_devices_household',
      'idx_household_users_household', 'idx_household_users_user',
      'idx_billing_line_items_household', 'idx_billing_line_items_period_household'
    ]) AS name
  LOOP
    IF to_regclass('public.' || item.name) IS NULL THEN
      problems := problems || format('index public.%s is missing', item.name);
    END IF;
  END LOOP;

  -- Triggers and policies, on their tables.
  FOR item IN
    SELECT * FROM (VALUES
      ('households', 'trg_mgm_require_community_plugin_enabled_households'),
      ('household_devices', 'trg_household_device_no_overlap')
    ) AS t(rel, name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = to_regclass('public.' || item.rel) AND tgname = item.name AND NOT tgisinternal
    ) THEN
      problems := problems || format('trigger %s on public.%s is missing', item.name, item.rel);
    END IF;
  END LOOP;
  FOR item IN
    SELECT * FROM (VALUES
      ('households', 'Authorized users can access households'),
      ('household_devices', 'Authorized users can access household_devices'),
      ('household_users', 'Authorized users can access household_users')
    ) AS t(rel, name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = item.rel AND policyname = item.name
    ) THEN
      problems := problems || format('policy "%s" on public.%s is missing', item.name, item.rel);
    END IF;
  END LOOP;

  -- The functions the migration replaces: the chain's bodies, and for the
  -- two it drops and creates again, the grants it restores (NULL: any).
  FOR item IN
    SELECT * FROM (VALUES
      ('fn_billing_line_item_closed_period_guard()',
       'e9a523b425e9cfac1423505893fc7127', NULL),
      ('fn_close_billing_period(uuid,boolean)',
       'ccd383c740f6014155e630189a38ac08', NULL),
      ('fn_create_household(uuid,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text)',
       'cd0c615974197e382ee3c8db6fbe8cca', NULL),
      ('fn_create_household_with_meter(uuid,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text)',
       '0ab52a291810b7de18fd37e6f6c0316e', NULL),
      ('fn_household_device_no_overlap()',
       '193dcb8a4a94518c3d33eeb66e5c878e', NULL),
      ('fn_mgm_require_community_plugin_enabled()',
       'c55368d583d9e8856511333c7e15a46e', NULL),
      ('fn_record_line_item_with_audit(uuid,uuid,uuid,numeric,numeric,numeric,jsonb,numeric,billing_line_item_reading_source,uuid,text,uuid,jsonb,uuid,text,text)',
       'e781f7101e4bc9241e014016188ee244', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'),
      ('fn_replace_household_device(uuid,uuid,date)',
       '92aea2891de8643204e5dac5325f8da5', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}')
    ) AS t(sig, body_md5, acl)
  LOOP
    IF to_regprocedure('public.' || item.sig) IS NULL THEN
      problems := problems || format('function %s is missing', item.sig);
    ELSIF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.' || item.sig)) <> item.body_md5 THEN
      problems := problems || format('function %s has a body the chain does not', item.sig);
    ELSIF item.acl IS NOT NULL
      AND (SELECT proacl::TEXT FROM pg_proc WHERE oid = to_regprocedure('public.' || item.sig)) IS DISTINCT FROM item.acl
    THEN
      problems := problems || format('function %s has grants other than %s', item.sig, item.acl);
    END IF;
  END LOOP;

  -- Nothing else that would keep naming households afterwards.
  FOR item IN
    SELECT p.oid::regprocedure::TEXT AS name FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
      AND pg_get_functiondef(p.oid) ILIKE '%household%'
      AND p.proname NOT IN ('fn_billing_line_item_closed_period_guard', 'fn_close_billing_period',
                            'fn_create_household', 'fn_create_household_with_meter',
                            'fn_household_device_no_overlap', 'fn_mgm_require_community_plugin_enabled',
                            'fn_record_line_item_with_audit', 'fn_replace_household_device')
    UNION ALL
    SELECT c.relname::TEXT FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
      AND pg_get_viewdef(c.oid) ILIKE '%household%'
      AND c.relname NOT IN ('microgrid_recent_activity', 'microgrid_shared_devices')
  LOOP
    problems := problems || format('%s names households and the migration does not change it', item.name);
  END LOOP;

  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = $1'
      INTO found_count USING '20261116230000';
    IF found_count > 0 THEN
      problems := problems || 'the history already lists 20261116230000'::TEXT;
    END IF;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION E'preflight failed, % problem(s):\n%',
      cardinality(problems), array_to_string(problems, E'\n')
      USING ERRCODE = 'P0001';
  END IF;
END
$$;

SELECT 'preflight passed' AS result;
