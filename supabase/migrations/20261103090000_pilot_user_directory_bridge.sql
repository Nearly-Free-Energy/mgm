-- 20261103090000_pilot_user_directory_bridge.sql
-- Forward upgrade from the deployed curated pilot schema to the user
-- directory, profile editing, access removal and shared-devices surfaces.
--
-- Background: the deployed MGM pilot was built from the reviewed base
-- migrations (through 00015) plus the curated
-- supabase/pilot/20260924_mgm_review_import_essentials.sql overlay, then
-- 00056 onward and the dated 2026* migrations — NOT the full inherited chain
-- (00016–00055). The earlier bridges (00057, the release-2 connection bridge,
-- 00064) restored what their releases needed. Relative to the screens that
-- shipped since, the pilot still lacks:
--   * public.fn_list_visible_users(UUID[]) — defined only in 00046 and
--     re-issued with its current return shape by 00052 §6. Settings > Users,
--     the billing audit history names, the bill PDF route and resend-invite
--     all call it.
--   * UPDATE on public.user_profiles and DELETE on public.user_roles for
--     authenticated — the overlay grants SELECT only on both, while the
--     profile and access-removal routes write through the caller's JWT.
--     RLS already limits both verbs: the user_profiles UPDATE policy is
--     self-or-super-admin (00012), user_roles has its policies in 00002 and
--     00013, and the BEFORE DELETE guard trigger from 00013 (re-issued by
--     20260926130210) still runs on every delete.
--   * SELECT on public.microgrid_shared_devices for authenticated — the
--     overlay revoked it, while Setup > Edges > Shared reads it. The view is
--     security_invoker (00004), so RLS on devices, edges and
--     household_devices applies to the caller.
--
-- This migration replays exactly those pieces, idempotently, so it is a
-- no-op on databases that already applied the full chain and an upgrade on
-- pilot-curated databases. The function is created only when it is missing,
-- so on a full-chain database the 00052 definition stays as it is. Role
-- changes are out of scope for this bridge. Do not add unrelated schema here.
--
-- Fail-closed: section 0 checks that the objects these grants depend on are
-- the ones this repository defines, and refuses to change anything when they
-- are not. That covers row level security on the five tables involved, the
-- UPDATE policies on user_profiles and the DELETE policies on user_roles, the
-- user_roles delete guard trigger, the three helpers the policies and the
-- function call, and the view's security_invoker option. A pilot database is
-- curated outside the normal chain, so this is checked on the database
-- itself rather than assumed from a rehearsal.
--
-- Rehearsal: supabase/scripts/rehearse-pilot-user-directory.sql puts a
-- scratch transaction into the pilot state, applies this file, exercises each
-- surface as an org manager and as a super admin, shows that the section 0
-- check refuses each kind of mismatch, and rolls back.
--
-- Rollback, on a pilot database only (on a full-chain database these objects
-- predate this migration and must stay):
--   REVOKE UPDATE (first_name, last_name, phone) ON public.user_profiles FROM authenticated;
--   REVOKE DELETE ON public.user_roles FROM authenticated;
--   REVOKE SELECT ON public.microgrid_shared_devices FROM authenticated;
--   DROP FUNCTION public.fn_list_visible_users(UUID[]);

-- ── 0. Preflight: refuse a database that does not match ─────────────────────
--
-- Expected values come from a database built from this repository: the
-- policies created by 00002, 00012 and 00013 (no later migration touches
-- them), the helper bodies of 00002 and 00012, and the guard body of
-- 20260926130210 in either of its two committed versions (the second added
-- ::text casts). Bodies are compared as md5 of the source with whitespace
-- removed. If a later migration deliberately changes one of these objects,
-- update the expected value here in the same commit; until then the check
-- describes exactly what the grants below were reviewed against.
--
-- The function lives in pg_temp so the rehearsal can call it on a modified
-- database; it disappears with the session.

CREATE OR REPLACE FUNCTION pg_temp.pilot_user_directory_preflight()
RETURNS TEXT[]
LANGUAGE plpgsql
AS $pf$
DECLARE
  v_problems   TEXT[] := ARRAY[]::TEXT[];
  v_saved_path TEXT   := current_setting('search_path');
  v_missing    TEXT[];
  v_policies   TEXT[];
  v_helper     RECORD;
BEGIN
  -- Policy expressions are deparsed relative to search_path; compare them
  -- under a fixed one.
  PERFORM set_config('search_path', 'public', true);

  SELECT array_agg(t ORDER BY t) INTO v_missing
  FROM unnest(ARRAY['devices', 'edges', 'household_devices', 'user_profiles', 'user_roles']) AS t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r' AND c.relrowsecurity
  );
  IF v_missing IS NOT NULL THEN
    v_problems := array_append(v_problems, format('row level security is not enabled on %s',
                                       array_to_string(v_missing, ', ')));
  END IF;

  SELECT array_agg(format('%s|%s|%s|%s|%s|%s', policyname, cmd, permissive, roles::text,
                          coalesce(qual, ''), coalesce(with_check, ''))
                   ORDER BY policyname)
    INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'user_profiles' AND cmd IN ('UPDATE', 'ALL');
  IF v_policies IS DISTINCT FROM ARRAY[
    'Users edit own profile or super_admin edits any|UPDATE|PERMISSIVE|{public}|((auth.uid() = user_id) OR is_super_admin())|((auth.uid() = user_id) OR is_super_admin())'
  ] THEN
    v_problems := array_append(v_problems, 'the UPDATE policies on user_profiles are not the ones 00012 creates');
  END IF;

  SELECT array_agg(format('%s|%s|%s|%s|%s|%s', policyname, cmd, permissive, roles::text,
                          coalesce(qual, ''), coalesce(with_check, ''))
                   ORDER BY policyname)
    INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'user_roles' AND cmd IN ('DELETE', 'ALL');
  IF v_policies IS DISTINCT FROM ARRAY[
    'Org managers can delete user_roles in their orgs|DELETE|PERMISSIVE|{public}|((scope_type = ''org''::role_scope_type) AND (scope_id IS NOT NULL) AND user_can_access_org(scope_id))|',
    'Super admins can manage all user_roles|ALL|PERMISSIVE|{public}|is_super_admin()|is_super_admin()'
  ] THEN
    v_problems := array_append(v_problems, 'the DELETE policies on user_roles are not the ones 00002 and 00013 create');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.user_roles'::regclass
      AND t.tgname = 'trg_user_roles_before_delete_guard'
      AND NOT t.tgisinternal
      AND t.tgenabled IN ('O', 'A')
      AND t.tgtype = 11  -- FOR EACH ROW, BEFORE, DELETE
      AND t.tgfoid = to_regprocedure('public.fn_user_roles_before_delete_guard()')
  ) THEN
    v_problems := array_append(v_problems, 'the user_roles delete guard trigger is missing, disabled or changed');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('public.fn_user_roles_before_delete_guard()')
      AND md5(regexp_replace(p.prosrc, '\s+', '', 'g')) IN (
        '109b706020776b510017152dfa7cb460',  -- 20260926130210 at 2eeb40a
        '4d868dbfa418ceef85b7fc9f785cd8f4'   -- 20260926130210 at 3d6da60
      )
  ) THEN
    v_problems := array_append(v_problems, 'fn_user_roles_before_delete_guard is not the version 20260926130210 creates');
  END IF;

  FOR v_helper IN
    SELECT * FROM (VALUES
      ('public.is_super_admin()',                  'cfc31fddba4d29b3eba36f158c41734e'),
      ('public.user_can_access_org(uuid)',         '0c99f1646760217211eeb01a233ca634'),
      ('public.user_can_see_user_profile(uuid)',   '658cb02ce7ef50301b9bee09bac0a587')
    ) AS h(signature, body_md5)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = to_regprocedure(v_helper.signature)
        AND p.prosecdef
        AND md5(regexp_replace(p.prosrc, '\s+', '', 'g')) = v_helper.body_md5
    ) THEN
      v_problems := array_append(v_problems, format('%s is missing or is not the version this repository defines',
                                         v_helper.signature));
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'microgrid_shared_devices' AND c.relkind = 'v'
      AND EXISTS (
        SELECT 1 FROM pg_options_to_table(c.reloptions) o
        WHERE o.option_name = 'security_invoker'
          AND lower(o.option_value) IN ('true', 'on', 'yes', '1')
      )
  ) THEN
    v_problems := array_append(v_problems, 'microgrid_shared_devices is missing or is not security_invoker');
  END IF;

  PERFORM set_config('search_path', v_saved_path, true);
  RETURN v_problems;
END;
$pf$;

DO $do$
DECLARE
  v_problems TEXT[] := pg_temp.pilot_user_directory_preflight();
BEGIN
  IF cardinality(v_problems) > 0 THEN
    RAISE EXCEPTION 'pilot user directory bridge refused: %', array_to_string(v_problems, '; ')
      USING HINT = 'Nothing was changed. Compare these objects with the migrations named in this file''s header before applying it.';
  END IF;
END;
$do$;

-- ── 1. fn_list_visible_users (00046, current shape from 00052 §6) ───────────
--
-- Same signature and return columns as 00052, so the generated types do not
-- change. ems_operator_count is kept for that reason; the one difference from
-- 00052 is that it compares ur2.role::text instead of the enum literal.
-- Pilot databases lack the 'ems_operator' enum label (00051 adds it), and a
-- SQL function body is validated when the function is created, so the enum
-- literal would make this CREATE fail there. The text comparison counts the
-- same rows wherever the label exists — if 00052's body changes, re-check
-- this copy against it.

DO $do$
BEGIN
  IF to_regprocedure('public.fn_list_visible_users(uuid[])') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION public.fn_list_visible_users(
        _target_user_ids UUID[] DEFAULT NULL
      )
      RETURNS TABLE (
        user_id            UUID,
        email              TEXT,
        email_confirmed_at TIMESTAMPTZ,
        last_sign_in_at    TIMESTAMPTZ,
        first_name         TEXT,
        last_name          TEXT,
        phone              TEXT,
        role               public.user_role,
        scope_type         public.role_scope_type,
        scope_id           UUID,
        ems_operator_count INTEGER
      )
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $body$
        SELECT
          au.id                        AS user_id,
          au.email::TEXT               AS email,
          au.email_confirmed_at,
          au.last_sign_in_at,
          up.first_name,
          up.last_name,
          up.phone,
          org_role.role,
          org_role.scope_type,
          org_role.scope_id,
          COALESCE(ems.cnt, 0)::INTEGER AS ems_operator_count
        FROM auth.users au
        LEFT JOIN public.user_profiles up ON up.user_id = au.id
        -- super_admin is ordered first so a user carrying both surfaces as
        -- super_admin, which is what the users list means by "role".
        LEFT JOIN LATERAL (
          SELECT ur.role, ur.scope_type, ur.scope_id
          FROM public.user_roles ur
          WHERE ur.user_id = au.id
            AND ur.scope_type = 'org'
          ORDER BY (ur.role = 'super_admin') DESC, ur.created_at
          LIMIT 1
        ) org_role ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS cnt
          FROM public.user_roles ur2
          WHERE ur2.user_id = au.id
            AND ur2.role::text = 'ems_operator'
        ) ems ON TRUE
        WHERE user_can_see_user_profile(au.id)
          AND (_target_user_ids IS NULL OR au.id = ANY(_target_user_ids));
      $body$
    $fn$;
  END IF;
END;
$do$;

REVOKE EXECUTE ON FUNCTION public.fn_list_visible_users(UUID[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_visible_users(UUID[]) TO authenticated, service_role;

-- ── 2. Table and view grants ────────────────────────────────────────────────
--
-- One verb each, exactly what the routes use: the profile route updates
-- user_profiles, the access-removal route deletes from user_roles, and the
-- shared-devices page selects from the view. No INSERT, no ALL and no default
-- privileges. UPDATE is limited to the three columns the profile route writes
-- (src/app/api/users/[id]/profile/route.ts): user_id, created_at and
-- updated_at stay out of a caller's reach, and updated_at is still set by the
-- trg_user_profiles_updated_at trigger. If the route starts writing another
-- column, widen this list with it. On full-chain databases these grants
-- already exist (00016 grants ALL) — GRANT is idempotent.

GRANT UPDATE (first_name, last_name, phone) ON public.user_profiles TO authenticated;
GRANT DELETE ON public.user_roles TO authenticated;
GRANT SELECT ON public.microgrid_shared_devices TO authenticated;
