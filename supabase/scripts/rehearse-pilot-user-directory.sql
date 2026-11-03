-- supabase/scripts/rehearse-pilot-user-directory.sql
-- Rehearsal for 20261103090000_pilot_user_directory_bridge.sql: the user
-- directory, profile editing, access removal and shared-devices surfaces on
-- a pilot-curated schema.
--
-- Run as a superuser (locally: supabase_admin), for example
--   psql "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/scripts/rehearse-pilot-user-directory.sql
--
-- A superuser is needed because the user_roles BEFORE DELETE guard (00013,
-- re-issued by 20260926130210) lets the postgres and supabase_admin session
-- users through, so the self-revocation step has to change session_user the
-- way a PostgREST connection does (session user authenticator, role
-- authenticated), and only a superuser may do that. Schema setup and the
-- bridge itself run as postgres, the role migrations run as.
--
-- Pass: NOTICE "OK: …" per step. Fail: RAISE EXCEPTION aborts (ON_ERROR_STOP).
--
-- Everything happens inside BEGIN … ROLLBACK, so nothing persists:
--   0. put the transaction into the pilot state: drop fn_list_visible_users
--      and reduce the grants to what the pilot overlay leaves (SELECT only on
--      user_profiles and user_roles, nothing on microgrid_shared_devices)
--   1. build fixtures: two orgs, two org managers in org A, one in org B,
--      a super admin, a microgrid per org with shared and linked devices
--   2. show the pilot state fails each surface as an org manager
--   3. apply the bridge with \ir
--   4. as an org manager and as a super admin, exactly as PostgREST would
--      (JWT claims + session user authenticator + SET ROLE authenticated):
--      the RPC lists the caller and the users they may see; profile updates
--      follow the self-or-super-admin policy and reach only first_name,
--      last_name and phone; an org manager removes no one else's role row
--      (not the super admin's, not a same-org peer's, not another org's); a
--      super admin can remove another user's role row while self-revocation
--      is still refused; the shared-devices view returns only rows the caller
--      may see.
--   5. the bridge's preflight passes here and refuses each kind of mismatch:
--      row level security off, an extra UPDATE policy, a disabled delete
--      guard, a changed helper, a view that is not security_invoker.

\set ON_ERROR_STOP on
\echo '======================================================================'
\echo ' Pilot user directory bridge rehearsal'
\echo '======================================================================'

BEGIN;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'run this rehearsal as a superuser (locally supabase_admin), see the header';
  END IF;
END;
$$;

SET SESSION AUTHORIZATION postgres;

-- ── 0. Pilot state ──────────────────────────────────────────────────────────
\echo '-- [0] pilot state (overlay grants, no fn_list_visible_users)'

DROP FUNCTION IF EXISTS public.fn_list_visible_users(UUID[]);

-- Mirrors supabase/pilot/20260924_mgm_review_import_essentials.sql for the
-- three objects the bridge touches.
REVOKE ALL ON TABLE public.user_profiles, public.user_roles
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_profiles, public.user_roles TO authenticated;
REVOKE ALL ON TABLE public.microgrid_shared_devices
  FROM PUBLIC, anon, authenticated;

-- ── 1. Fixtures ─────────────────────────────────────────────────────────────
\echo '-- [1] fixtures (orgs, users, microgrids, devices)'

DO $$
DECLARE
  v_org_a UUID := gen_random_uuid();
  v_org_b UUID := gen_random_uuid();
  v_m UUID := gen_random_uuid();  -- org manager, org A (main caller)
  v_n UUID := gen_random_uuid();  -- org manager, org A
  v_o UUID := gen_random_uuid();  -- org manager, org B
  v_s UUID := gen_random_uuid();  -- super admin
  v_uid UUID;
  v_comm UUID;
  v_mg UUID;
  v_edge UUID;
  v_hh UUID;
  v_dev_a_shared UUID;
  v_dev_a_linked UUID;
  v_dev_b_shared UUID;
BEGIN
  INSERT INTO organizations(id, name, address_city, address_country)
  VALUES (v_org_a, 'Directory Rehearsal Org A', 'Kampala', 'Uganda'),
         (v_org_b, 'Directory Rehearsal Org B', 'Kampala', 'Uganda');

  FOREACH v_uid IN ARRAY ARRAY[v_m, v_n, v_o, v_s] LOOP
    INSERT INTO auth.users(
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, email_change,
      email_change_token_new, recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated',
      'authenticated', 'directory-rehearsal-' || v_uid::text || '@test.local',
      'x', now(), '{}', '{}', now(), now(), '', '', '', ''
    );
    -- Full-chain databases create the profile from an auth.users trigger;
    -- pilot databases may not, so insert it when it is missing.
    INSERT INTO user_profiles(user_id, first_name, last_name)
    VALUES (v_uid, 'Rehearsal', 'User')
    ON CONFLICT (user_id) DO NOTHING;
  END LOOP;

  INSERT INTO user_roles(user_id, role, scope_type, scope_id) VALUES
    (v_m, 'org_manager', 'org', v_org_a),
    (v_n, 'org_manager', 'org', v_org_a),
    (v_o, 'org_manager', 'org', v_org_b),
    (v_s, 'super_admin', 'org', NULL);

  -- Org A: one shared device and one linked to a household.
  INSERT INTO communities(org_id, name) VALUES (v_org_a, 'Rehearsal Community A')
  RETURNING id INTO v_comm;
  INSERT INTO microgrids(community_id, name) VALUES (v_comm, 'Rehearsal Microgrid A')
  RETURNING id INTO v_mg;
  INSERT INTO edges(microgrid_id, name, openems_edge_id)
  VALUES (v_mg, 'Rehearsal Edge A', 'edge-rehearsal-a')
  RETURNING id INTO v_edge;
  INSERT INTO devices(edge_id, name, device_type, openems_component_id)
  VALUES (v_edge, 'Rehearsal grid meter A', 'grid_meter', 'meterGrid0')
  RETURNING id INTO v_dev_a_shared;
  INSERT INTO devices(edge_id, name, device_type, openems_component_id)
  VALUES (v_edge, 'Rehearsal household meter A', 'consumption_meter', 'meter1')
  RETURNING id INTO v_dev_a_linked;
  INSERT INTO households(microgrid_id, display_name, primary_phone)
  VALUES (v_mg, 'Rehearsal Household A', '+256700000002')
  RETURNING id INTO v_hh;
  INSERT INTO household_devices(household_id, device_id, role)
  VALUES (v_hh, v_dev_a_linked, 'primary_consumption_meter');

  -- Org B: one shared device the org A manager must not see.
  INSERT INTO communities(org_id, name) VALUES (v_org_b, 'Rehearsal Community B')
  RETURNING id INTO v_comm;
  INSERT INTO microgrids(community_id, name) VALUES (v_comm, 'Rehearsal Microgrid B')
  RETURNING id INTO v_mg;
  INSERT INTO edges(microgrid_id, name, openems_edge_id)
  VALUES (v_mg, 'Rehearsal Edge B', 'edge-rehearsal-b')
  RETURNING id INTO v_edge;
  INSERT INTO devices(edge_id, name, device_type, openems_component_id)
  VALUES (v_edge, 'Rehearsal grid meter B', 'grid_meter', 'meterGrid0')
  RETURNING id INTO v_dev_b_shared;

  -- Transaction-local settings carry the ids across roles and DO blocks.
  PERFORM set_config('rehearsal.m', v_m::text, true);
  PERFORM set_config('rehearsal.n', v_n::text, true);
  PERFORM set_config('rehearsal.o', v_o::text, true);
  PERFORM set_config('rehearsal.s', v_s::text, true);
  PERFORM set_config('rehearsal.dev_a_shared', v_dev_a_shared::text, true);
  PERFORM set_config('rehearsal.dev_a_linked', v_dev_a_linked::text, true);
  PERFORM set_config('rehearsal.dev_b_shared', v_dev_b_shared::text, true);
  RAISE NOTICE 'OK: fixtures created';
END;
$$;

-- ── 2. Pilot state fails each surface (org manager) ─────────────────────────
\echo '-- [2] pilot state, as an org manager'

SELECT set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('rehearsal.m'), 'role', 'authenticated')::text,
  true);
SET SESSION AUTHORIZATION authenticator;
SET ROLE authenticated;

DO $$
DECLARE
  v_m UUID := current_setting('rehearsal.m')::uuid;
  v_n UUID := current_setting('rehearsal.n')::uuid;
BEGIN
  BEGIN
    PERFORM * FROM fn_list_visible_users();
    RAISE EXCEPTION 'pilot state still has fn_list_visible_users';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'OK: pilot state has no fn_list_visible_users';
  END;

  BEGIN
    UPDATE user_profiles SET first_name = 'Pilot' WHERE user_id = v_m;
    RAISE EXCEPTION 'pilot state already allows profile updates';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK: pilot state refuses profile updates (%)', SQLERRM;
  END;

  BEGIN
    DELETE FROM user_roles WHERE user_id = v_n;
    RAISE EXCEPTION 'pilot state already allows role row deletes';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK: pilot state refuses role row deletes (%)', SQLERRM;
  END;

  BEGIN
    PERFORM 1 FROM microgrid_shared_devices;
    RAISE EXCEPTION 'pilot state already allows the shared-devices view';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK: pilot state refuses the shared-devices view (%)', SQLERRM;
  END;
END;
$$;

RESET ROLE;
SET SESSION AUTHORIZATION postgres;

-- ── 3. Apply the bridge ─────────────────────────────────────────────────────
\echo '-- [3] apply 20261103090000_pilot_user_directory_bridge.sql'
\ir ../migrations/20261103090000_pilot_user_directory_bridge.sql

DO $$
BEGIN
  IF to_regprocedure('public.fn_list_visible_users(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'bridge did not create fn_list_visible_users';
  END IF;
  IF has_function_privilege('anon', 'public.fn_list_visible_users(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute fn_list_visible_users';
  END IF;
  IF has_table_privilege('authenticated', 'public.user_profiles', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_profiles', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.user_roles', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_roles', 'UPDATE') THEN
    RAISE EXCEPTION 'bridge granted more than column UPDATE on user_profiles and DELETE on user_roles';
  END IF;
  IF NOT (has_column_privilege('authenticated', 'public.user_profiles', 'first_name', 'UPDATE')
          AND has_column_privilege('authenticated', 'public.user_profiles', 'last_name', 'UPDATE')
          AND has_column_privilege('authenticated', 'public.user_profiles', 'phone', 'UPDATE'))
     OR has_column_privilege('authenticated', 'public.user_profiles', 'user_id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.user_profiles', 'created_at', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.user_profiles', 'updated_at', 'UPDATE') THEN
    RAISE EXCEPTION 'user_profiles UPDATE is not limited to first_name, last_name and phone';
  END IF;
  RAISE NOTICE 'OK: bridge applied (function created, anon denied, profile UPDATE limited to three columns, no extra verbs)';
END;
$$;

-- ── 4a. Org manager after the bridge ────────────────────────────────────────
\echo '-- [4a] after the bridge, as an org manager'

SELECT set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('rehearsal.m'), 'role', 'authenticated')::text,
  true);
SET SESSION AUTHORIZATION authenticator;
SET ROLE authenticated;

DO $$
DECLARE
  v_m UUID := current_setting('rehearsal.m')::uuid;
  v_n UUID := current_setting('rehearsal.n')::uuid;
  v_o UUID := current_setting('rehearsal.o')::uuid;
  v_s UUID := current_setting('rehearsal.s')::uuid;
  v_ids UUID[];
  v_rows INT;
  v_devices UUID[];
BEGIN
  -- RPC: the caller and the other manager of org A, nobody else.
  SELECT array_agg(user_id ORDER BY user_id) INTO v_ids
  FROM fn_list_visible_users();
  IF NOT (v_ids @> ARRAY[v_m, v_n]) OR v_ids && ARRAY[v_o, v_s] THEN
    RAISE EXCEPTION 'org manager RPC listing wrong: %', v_ids;
  END IF;
  IF cardinality(v_ids) <> 2 THEN
    RAISE EXCEPTION 'org manager sees users outside org A: %', v_ids;
  END IF;

  SELECT array_agg(user_id) INTO v_ids
  FROM fn_list_visible_users(ARRAY[v_n, v_o]);
  IF v_ids IS DISTINCT FROM ARRAY[v_n] THEN
    RAISE EXCEPTION 'targeted RPC listing wrong: %', v_ids;
  END IF;

  PERFORM 1 FROM fn_list_visible_users(ARRAY[v_n])
  WHERE role = 'org_manager' AND scope_type = 'org' AND ems_operator_count = 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RPC row for org A manager has the wrong role columns';
  END IF;
  RAISE NOTICE 'OK: org manager RPC lists self and org A manager only';

  -- Profiles: own row yes, another user's row no (RLS filters to 0 rows).
  UPDATE user_profiles SET first_name = 'Self edit' WHERE user_id = v_m;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'org manager could not update own profile (% rows)', v_rows;
  END IF;
  UPDATE user_profiles SET first_name = 'Not allowed' WHERE user_id = v_n;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'org manager updated another user''s profile (% rows)', v_rows;
  END IF;
  RAISE NOTICE 'OK: org manager updates own profile, not another user''s';

  -- Own row, other columns: phone is granted; user_id and created_at are not.
  UPDATE user_profiles SET phone = '+256700000009' WHERE user_id = v_m;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'org manager could not update own phone (% rows)', v_rows;
  END IF;
  BEGIN
    UPDATE user_profiles SET created_at = now() - interval '1 year' WHERE user_id = v_m;
    RAISE EXCEPTION 'org manager changed own created_at';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    UPDATE user_profiles SET user_id = v_n WHERE user_id = v_m;
    RAISE EXCEPTION 'org manager changed own user_id';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RAISE NOTICE 'OK: org manager updates own phone, not own user_id or created_at';

  -- Role rows: self-revocation refused by the guard trigger; another org's
  -- row is outside the delete policy.
  BEGIN
    DELETE FROM user_roles WHERE user_id = v_m;
    RAISE EXCEPTION 'org manager self-revocation was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'Cannot revoke your own access%' THEN
      RAISE EXCEPTION 'self-revocation refused for the wrong reason: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK: org manager self-revocation refused (%)', SQLERRM;
  END;
  DELETE FROM user_roles WHERE user_id = v_o;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'org manager removed a role row in another org (% rows)', v_rows;
  END IF;
  RAISE NOTICE 'OK: org manager cannot remove a role row in another org';

  -- The super admin's row: its scope_id is NULL, so the org-manager DELETE
  -- policy never covers it. Step 4b finds the row still there.
  DELETE FROM user_roles WHERE user_id = v_s;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'org manager removed the super admin''s role row (% rows)', v_rows;
  END IF;
  RAISE NOTICE 'OK: org manager cannot remove the super admin''s role row';

  -- A same-org peer's row: refused too, as the base policies already behave.
  -- A DELETE with a WHERE clause only reaches rows the SELECT policies show,
  -- and those show an org manager their own role rows only, so the 00013
  -- org-manager DELETE policy never applies to a peer. Step 4b removes the
  -- same row as a super admin, which shows it was still there.
  DELETE FROM user_roles WHERE user_id = v_n;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'org manager removed a same-org peer''s role row (% rows)', v_rows;
  END IF;
  RAISE NOTICE 'OK: org manager cannot remove a same-org peer''s role row (unchanged base behaviour)';

  -- Shared devices: org A's unlinked device only.
  SELECT array_agg(id) INTO v_devices FROM microgrid_shared_devices;
  IF v_devices IS DISTINCT FROM ARRAY[current_setting('rehearsal.dev_a_shared')::uuid] THEN
    RAISE EXCEPTION 'org manager shared-devices listing wrong: %', v_devices;
  END IF;
  RAISE NOTICE 'OK: org manager sees only org A''s shared device';
END;
$$;

RESET ROLE;
SET SESSION AUTHORIZATION postgres;

-- ── 4b. Super admin after the bridge ────────────────────────────────────────
\echo '-- [4b] after the bridge, as a super admin'

SELECT set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('rehearsal.s'), 'role', 'authenticated')::text,
  true);
SET SESSION AUTHORIZATION authenticator;
SET ROLE authenticated;

DO $$
DECLARE
  v_m UUID := current_setting('rehearsal.m')::uuid;
  v_n UUID := current_setting('rehearsal.n')::uuid;
  v_o UUID := current_setting('rehearsal.o')::uuid;
  v_s UUID := current_setting('rehearsal.s')::uuid;
  v_rows INT;
  v_devices UUID[];
BEGIN
  SELECT COUNT(*) INTO v_rows
  FROM fn_list_visible_users(ARRAY[v_m, v_n, v_o, v_s]);
  IF v_rows <> 4 THEN
    RAISE EXCEPTION 'super admin RPC listing wrong: % of 4 users', v_rows;
  END IF;
  RAISE NOTICE 'OK: super admin RPC lists users in every org';

  UPDATE user_profiles SET first_name = 'Admin edit' WHERE user_id = v_n;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'super admin could not update another user''s profile (% rows)', v_rows;
  END IF;
  RAISE NOTICE 'OK: super admin updates another user''s profile';

  DELETE FROM user_roles WHERE user_id = v_n;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'super admin could not remove another user''s role row (% rows)', v_rows;
  END IF;
  RAISE NOTICE 'OK: super admin removes another user''s role row';

  BEGIN
    DELETE FROM user_roles WHERE user_id = v_s;
    RAISE EXCEPTION 'super admin self-revocation was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'Cannot revoke your own access%' THEN
      RAISE EXCEPTION 'self-revocation refused for the wrong reason: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK: super admin self-revocation refused (%)', SQLERRM;
  END;

  SELECT array_agg(id) INTO v_devices FROM microgrid_shared_devices
  WHERE id IN (
    current_setting('rehearsal.dev_a_shared')::uuid,
    current_setting('rehearsal.dev_a_linked')::uuid,
    current_setting('rehearsal.dev_b_shared')::uuid
  );
  IF cardinality(v_devices) <> 2
     OR NOT (v_devices @> ARRAY[
       current_setting('rehearsal.dev_a_shared')::uuid,
       current_setting('rehearsal.dev_b_shared')::uuid
     ]) THEN
    RAISE EXCEPTION 'super admin shared-devices listing wrong: %', v_devices;
  END IF;
  RAISE NOTICE 'OK: super admin sees both shared devices and not the linked one';
END;
$$;

RESET ROLE;
SET SESSION AUTHORIZATION postgres;

-- ── 5. The preflight refuses a database that does not match ─────────────────
-- pg_temp.pilot_user_directory_preflight() was created by the bridge in step
-- 3. Each drift is made inside a savepoint and rolled back.
\echo '-- [5] bridge preflight against matching and drifted databases'

DO $$
DECLARE
  v_problems TEXT[] := pg_temp.pilot_user_directory_preflight();
BEGIN
  IF cardinality(v_problems) <> 0 THEN
    RAISE EXCEPTION 'preflight reports problems on the rehearsal database: %', v_problems;
  END IF;
  RAISE NOTICE 'OK: preflight passes on the bridged rehearsal database';
END;
$$;

SAVEPOINT drift;
ALTER TABLE public.user_profiles DISABLE ROW LEVEL SECURITY;
DO $$
DECLARE v TEXT := array_to_string(pg_temp.pilot_user_directory_preflight(), '; ');
BEGIN
  IF v NOT LIKE '%row level security is not enabled on user_profiles%' THEN
    RAISE EXCEPTION 'preflight missed RLS off on user_profiles: %', v;
  END IF;
  RAISE NOTICE 'OK: preflight refuses RLS off (%)', v;
END;
$$;
ROLLBACK TO SAVEPOINT drift;

CREATE POLICY "rehearsal drift: anyone updates profiles"
  ON public.user_profiles FOR UPDATE USING (true);
DO $$
DECLARE v TEXT := array_to_string(pg_temp.pilot_user_directory_preflight(), '; ');
BEGIN
  IF v NOT LIKE '%UPDATE policies on user_profiles%' THEN
    RAISE EXCEPTION 'preflight missed an extra UPDATE policy: %', v;
  END IF;
  RAISE NOTICE 'OK: preflight refuses an extra UPDATE policy (%)', v;
END;
$$;
ROLLBACK TO SAVEPOINT drift;

ALTER TABLE public.user_roles DISABLE TRIGGER trg_user_roles_before_delete_guard;
DO $$
DECLARE v TEXT := array_to_string(pg_temp.pilot_user_directory_preflight(), '; ');
BEGIN
  IF v NOT LIKE '%delete guard trigger%' THEN
    RAISE EXCEPTION 'preflight missed a disabled delete guard: %', v;
  END IF;
  RAISE NOTICE 'OK: preflight refuses a disabled delete guard (%)', v;
END;
$$;
ROLLBACK TO SAVEPOINT drift;

CREATE OR REPLACE FUNCTION public.user_can_see_user_profile(_target_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$ SELECT TRUE $fn$;
DO $$
DECLARE v TEXT := array_to_string(pg_temp.pilot_user_directory_preflight(), '; ');
BEGIN
  IF v NOT LIKE '%user_can_see_user_profile(uuid) is missing or is not the version%' THEN
    RAISE EXCEPTION 'preflight missed a changed helper: %', v;
  END IF;
  RAISE NOTICE 'OK: preflight refuses a changed helper (%)', v;
END;
$$;
ROLLBACK TO SAVEPOINT drift;

ALTER VIEW public.microgrid_shared_devices SET (security_invoker = false);
DO $$
DECLARE v TEXT := array_to_string(pg_temp.pilot_user_directory_preflight(), '; ');
BEGIN
  IF v NOT LIKE '%microgrid_shared_devices is missing or is not security_invoker%' THEN
    RAISE EXCEPTION 'preflight missed a view without security_invoker: %', v;
  END IF;
  RAISE NOTICE 'OK: preflight refuses a view without security_invoker (%)', v;
END;
$$;
ROLLBACK TO SAVEPOINT drift;
RELEASE SAVEPOINT drift;

RESET SESSION AUTHORIZATION;

ROLLBACK;

\echo ' Pilot user directory rehearsal complete — all steps passed, rolled back.'
