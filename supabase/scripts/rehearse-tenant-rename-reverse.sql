-- Scratch databases and CI only; every change rolls back.
--
-- Rehearses reverse-tenant-rename.sql on a database the chain built, so
-- after 20261116230000_rename_households_to_tenants.sql:
--
--   1. runs the reverse and takes the migration out of the history, as the
--      rollback does (`supabase migration repair --status reverted`);
--   2. as an org manager, uses what the release before the rename calls,
--      by the parameter names it passes: fn_create_household, the
--      primary-meter overlap trigger, fn_replace_household_device,
--      fn_record_line_item_with_audit, fn_close_billing_period and the
--      activity view;
--   3. runs preflight-tenant-rename.sql, which must pass;
--   4. applies the migration again, and checks the public schema is the one
--      it produced the first time.
--
-- It holds only until a later migration changes an object the rename
-- touches: the reverse undoes the rename on top of the release it ships in,
-- and step 4 then fails. By that time the release after it is the rollback
-- target; delete this file, the reverse, the preflight and their CI step.

\set ON_ERROR_STOP on
BEGIN;

-- Everything in the public schema that a rename, a function body, a grant or
-- a comment can change. No object ids: dropping and creating a function
-- again gives it a new one.
CREATE FUNCTION pg_temp.public_schema_fingerprint() RETURNS TEXT LANGUAGE sql AS $fp$
  SELECT md5(string_agg(line, E'\n' ORDER BY line)) FROM (
    SELECT format('rel %s %s %s %s', c.relname, c.relkind, c.reloptions, c.relacl) AS line
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
    UNION ALL
    SELECT format('col %s.%s %s %s %s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                  a.attnotnull, pg_get_expr(d.adbin, d.adrelid))
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT format('con %s %s %s', conrelid::regclass, conname, pg_get_constraintdef(oid))
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace
    UNION ALL
    SELECT format('idx %s', pg_get_indexdef(indexrelid))
      FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
    UNION ALL
    SELECT format('trg %s', pg_get_triggerdef(oid))
      FROM pg_trigger WHERE NOT tgisinternal
       AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
    UNION ALL
    SELECT format('pol %s %s %s %s %s %s', tablename, policyname, cmd, roles, qual, with_check)
      FROM pg_policies WHERE schemaname = 'public'
    UNION ALL
    SELECT format('fn %s %s %s', p.oid::regprocedure, p.proacl, pg_get_functiondef(p.oid))
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
    UNION ALL
    SELECT format('view %s %s', c.relname, pg_get_viewdef(c.oid))
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
    UNION ALL
    SELECT format('type %s %s', t.typname, (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
                                             FROM pg_enum WHERE enumtypid = t.oid))
      FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype = 'e'
    UNION ALL
    SELECT format('comment %s.%s %s', c.relname, d.objsubid, d.description)
      FROM pg_description d JOIN pg_class c ON c.oid = d.objoid
      WHERE d.classoid = 'pg_class'::regclass AND c.relnamespace = 'public'::regnamespace
  ) lines
$fp$;
CREATE TEMP TABLE rehearsal_fingerprint AS SELECT pg_temp.public_schema_fingerprint() AS after_migration;

-- 1. Reverse, and the history repair that goes with it.
\ir reverse-tenant-rename.sql
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261116230000';

-- 2. The release before the rename, as an org manager.
DO $$
DECLARE
  org UUID := gen_random_uuid();
  manager UUID := gen_random_uuid();
  community UUID; grid UUID; edge UUID; meter UUID; spare UUID; tariff UUID; period UUID;
  household UUID; bill billing_line_items%ROWTYPE; n INTEGER;
BEGIN
  INSERT INTO organizations(id, name) VALUES (org, 'Tenant rename reverse rehearsal');
  INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (manager, 'authenticated', 'authenticated', manager::TEXT || '@test.local', '{}', '{}');
  INSERT INTO user_roles(user_id, role, scope_type, scope_id) VALUES (manager, 'org_manager', 'org', org);

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', manager, 'role', 'authenticated')::TEXT, true);
  SET ROLE authenticated;
  INSERT INTO communities(org_id, name) VALUES (org, 'Reverse community') RETURNING id INTO community;
  INSERT INTO microgrids(community_id, name, currency, timezone)
  VALUES (community, 'Reverse grid', 'UGX', 'Africa/Kampala') RETURNING id INTO grid;
  INSERT INTO edges(microgrid_id, name, openems_edge_id) VALUES (grid, 'Reverse edge', 'edge-reverse') RETURNING id INTO edge;
  INSERT INTO devices(edge_id, name, device_type, openems_component_id)
  VALUES (edge, 'Meter 1', 'consumption_meter', 'meter1') RETURNING id INTO meter;
  INSERT INTO devices(edge_id, name, device_type, openems_component_id)
  VALUES (edge, 'Meter 2', 'consumption_meter', 'meter2') RETURNING id INTO spare;
  INSERT INTO rate_schedules(microgrid_id, tiers, service_charge, tax_rate)
  VALUES (grid, '[{"label": "T1", "min_kwh": 1, "max_kwh": null, "rate_per_kwh": 100}]', 0, 0) RETURNING id INTO tariff;
  SELECT id INTO period FROM fn_create_billing_period(grid, '2026-08-01', '2026-08-31');

  household := fn_create_household(p_microgrid_id := grid, p_display_name := 'Reverse household',
                                   p_device_id := meter, p_primary_phone := '+256700000097');
  IF (SELECT count(*) FROM household_devices WHERE household_id = household) <> 1 THEN
    RAISE EXCEPTION 'fn_create_household did not link the meter';
  END IF;

  BEGIN
    INSERT INTO household_devices(household_id, device_id, role, effective_from)
    SELECT household, spare, 'primary_consumption_meter', effective_from
      FROM household_devices WHERE household_id = household;
    RAISE EXCEPTION 'an overlapping primary meter was accepted' USING ERRCODE = 'XX000';
  EXCEPTION WHEN unique_violation OR exclusion_violation THEN
    IF SQLERRM NOT ILIKE '%overlap%' THEN RAISE; END IF;
  END;

  PERFORM fn_replace_household_device(p_household_id := household, p_device_id := spare,
                                      p_effective_date := current_date + 1);
  SELECT count(*) INTO n FROM household_devices
  WHERE household_id = household AND device_id = spare AND effective_to IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'fn_replace_household_device did not assign the new meter'; END IF;

  SELECT * INTO bill FROM fn_record_line_item_with_audit(
    _billing_period_id := period, _household_id := household, _device_id := NULL,
    _usage_kwh := 12.5, _start_kwh := 100, _end_kwh := 112.5,
    _tier_breakdown := '[{"label": "T1", "kwh": 12.5, "amount": 1250}]', _total_amount := 1250,
    _reading_source := 'edge', _entered_by_user_id := NULL, _manual_reason := NULL,
    _actor_user_id := manager, _audit_details := '{"household_name": "Reverse household"}',
    _rate_schedule_id := tariff, _actor_kind := 'human', _actor_ref := NULL);
  IF bill.household_id IS DISTINCT FROM household THEN
    RAISE EXCEPTION 'fn_record_line_item_with_audit did not bill the household';
  END IF;

  PERFORM fn_close_billing_period(period, false);
  IF (SELECT status FROM billing_periods WHERE id = period) <> 'closed' THEN
    RAISE EXCEPTION 'fn_close_billing_period did not close the period';
  END IF;
  RESET ROLE;

  -- No grants for authenticated since 20261114222000; read as the owner.
  SELECT count(*) INTO n FROM microgrid_recent_activity
  WHERE microgrid_id = grid AND kind = 'household_added' AND description = 'Household added: Reverse household';
  IF n <> 1 THEN RAISE EXCEPTION 'the activity view does not report the household'; END IF;
  RAISE NOTICE 'OK: the release before the rename works after the reverse';
END
$$;

-- 3. The preflight passes on the reversed schema.
\ir preflight-tenant-rename.sql

-- 4. The migration again, to the same schema.
\ir ../migrations/20261116230000_rename_households_to_tenants.sql
DO $$
BEGIN
  IF pg_temp.public_schema_fingerprint() IS DISTINCT FROM (SELECT after_migration FROM rehearsal_fingerprint) THEN
    RAISE EXCEPTION 'the migration after the reverse gives a different public schema';
  END IF;
  RAISE NOTICE 'OK: reverse, then the migration again, gives the same public schema';
END
$$;

ROLLBACK;
