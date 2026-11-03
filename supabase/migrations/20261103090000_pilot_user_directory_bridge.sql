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
-- Rehearsal: supabase/scripts/rehearse-pilot-user-directory.sql puts a
-- scratch transaction into the pilot state, applies this file, exercises each
-- surface as an org manager and as a super admin, and rolls back.

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
-- privileges. On full-chain databases these grants already exist (00016) —
-- GRANT is idempotent.

GRANT UPDATE ON public.user_profiles TO authenticated;
GRANT DELETE ON public.user_roles TO authenticated;
GRANT SELECT ON public.microgrid_shared_devices TO authenticated;
