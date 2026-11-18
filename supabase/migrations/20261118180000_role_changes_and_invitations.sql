-- Role changes by super admins, and invitations for accounts without access.
--
-- 1. fn_change_user_role is a super-admin action. The Users page offers role
--    changes only to super admins (users-page-client.tsx, canChangeRoleAny);
--    the function now says the same. Its scope checks, the self-target guard
--    and its replace semantics are unchanged.
-- 2. fn_finalize_user_invitation finalizes only an account that holds no
--    role row, of any scope, and fills only the empty fields of its profile.
--    That is what POST /api/users/invite already sends it: a new account, or
--    an existing one with no roles, with the profile fields the person has
--    kept. An account with a tenant row counts as holding a role: making an
--    existing tenant staff is a separate flow (RFC mgm#197).
-- 3. fn_user_roles_before_delete_guard bypasses its checks only for an
--    administrator login that carries no API request.
--
-- Signatures and grants are unchanged, so database.gen.ts does not change.
-- is_super_admin, user_can_access_org, user_can_access_microgrid and
-- user_can_see_user_profile are called, not edited.

-- ── 1. fn_change_user_role ───────────────────────────────────────────────
-- The body of 20261114230100 with one check added, marked below.

CREATE OR REPLACE FUNCTION public.fn_change_user_role(p_user_id uuid, p_role user_role, p_scope_id uuid DEFAULT NULL::uuid, p_scope_type role_scope_type DEFAULT 'org'::role_scope_type)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  -- Added (20261118180000): changing a role is a super-admin action, as the
  -- Users page offers it (users-page-client.tsx). An organization manager
  -- invites and revokes; a super admin changes roles.
  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'Only super admins can change roles.'
      USING ERRCODE = '42501';
  END IF;

  -- Self-targeting guard, unchanged in intent but now limited to the org
  -- path. That path is destructive (it replaces the caller's own org role and
  -- can lock them out); a microgrid grant is purely additive and carries no
  -- self-lockout risk.
  IF p_user_id = auth.uid() AND p_scope_type = 'org' THEN
    RAISE EXCEPTION 'Cannot revoke your own access. Ask another administrator.'
      USING ERRCODE = '42501';
  END IF;

  IF p_role = 'super_admin' THEN
    IF NOT is_super_admin() THEN
      RAISE EXCEPTION 'Only super admins can assign super_admin.'
        USING ERRCODE = '42501';
    END IF;
    IF p_scope_type <> 'org' THEN
      RAISE EXCEPTION 'super_admin roles must use the org scope type.'
        USING ERRCODE = '22023';
    END IF;
    IF p_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'super_admin roles must have NULL scope_id.'
        USING ERRCODE = '22023';
    END IF;

  ELSIF p_role = 'org_manager' THEN
    IF p_scope_type <> 'org' THEN
      RAISE EXCEPTION 'org_manager roles must use the org scope type.'
        USING ERRCODE = '22023';
    END IF;
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'org_manager requires a scope_id (org).'
        USING ERRCODE = '22023';
    END IF;
    IF NOT user_can_access_org(p_scope_id) THEN
      RAISE EXCEPTION 'You do not have permission to assign this organization.'
        USING ERRCODE = '42501';
    END IF;

  ELSIF p_role = 'ems_operator' THEN
    -- The rollout grant. Existing microgrids have no creator, so nobody holds
    -- the grant on them; a super_admin grants explicitly rather than the
    -- migration inferring an owner from data that does not carry one.
    --
    -- Restricted to super_admin because the general grant-management surface
    -- is out of scope for #316 — widen this when someone needs access to a
    -- microgrid they did not create.
    IF NOT is_super_admin() THEN
      RAISE EXCEPTION 'Only super admins can assign ems_operator.'
        USING ERRCODE = '42501';
    END IF;
    IF p_scope_type <> 'microgrid' THEN
      RAISE EXCEPTION 'ems_operator roles must use the microgrid scope type.'
        USING ERRCODE = '22023';
    END IF;
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'ems_operator requires a scope_id (microgrid).'
        USING ERRCODE = '22023';
    END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported role: %', p_role
      USING ERRCODE = '22023';
  END IF;

  IF p_scope_type = 'org' THEN
    -- Replace the target's org role. Scoped DELETE: microgrid-scoped grants
    -- are not part of what the caller asked to change, so they survive.
    -- The BEFORE DELETE trigger still fires per row, so the self-revocation
    -- and last-super_admin guards continue to apply.
    DELETE FROM user_roles
     WHERE user_id = p_user_id
       AND scope_type = 'org';

    INSERT INTO user_roles (user_id, role, scope_type, scope_id)
      VALUES (p_user_id, p_role, 'org', p_scope_id);
  ELSE
    -- Additive grant. No DELETE at all: granting one microgrid must not
    -- revoke another.
    INSERT INTO user_roles (user_id, role, scope_type, scope_id)
      VALUES (p_user_id, p_role, p_scope_type, p_scope_id)
      ON CONFLICT (user_id, role, scope_type, scope_id) DO NOTHING;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_change_user_role(UUID, public.user_role, UUID, public.role_scope_type) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_change_user_role(UUID, public.user_role, UUID, public.role_scope_type) TO authenticated, service_role;

-- ── 2. fn_finalize_user_invitation ──────────────────────────────────────
-- The body of 00013 with the account check added and the profile upsert
-- changed to fill empty fields only, both marked below.

CREATE OR REPLACE FUNCTION public.fn_finalize_user_invitation(
  p_user_id    UUID,
  p_first_name TEXT,
  p_last_name  TEXT,
  p_phone      TEXT,
  p_role       public.user_role,
  p_scope_id   UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  IF p_role = 'super_admin' THEN
    IF NOT is_super_admin() THEN
      RAISE EXCEPTION 'Only super admins can invite super admins.'
        USING ERRCODE = '42501';
    END IF;
    IF p_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'super_admin roles must have NULL scope_id.'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_role = 'org_manager' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'org_manager invitations require a scope_id (org).'
        USING ERRCODE = '22023';
    END IF;
    IF NOT user_can_access_org(p_scope_id) THEN
      RAISE EXCEPTION 'You do not have permission to invite into this organization.'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported role: %', p_role
      USING ERRCODE = '22023';
  END IF;

  -- Added (20261118180000): an invitation is for an account with no role.
  -- Any row counts, tenant rows included: the invite route refuses those
  -- accounts too, and a change to an existing role is fn_change_user_role.
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'This account already has access. A super admin can change it from the Users list.'
      USING ERRCODE = '42501';
  END IF;

  -- Changed (20261118180000): fill only the fields the person has left
  -- empty, as the invite route already does, instead of replacing them.
  INSERT INTO user_profiles (user_id, first_name, last_name, phone)
    VALUES (p_user_id, p_first_name, p_last_name, p_phone)
    ON CONFLICT (user_id) DO UPDATE
      SET first_name = COALESCE(NULLIF(user_profiles.first_name, ''), EXCLUDED.first_name),
          last_name  = COALESCE(NULLIF(user_profiles.last_name, ''), EXCLUDED.last_name),
          phone      = COALESCE(NULLIF(user_profiles.phone, ''), EXCLUDED.phone);

  INSERT INTO user_roles (user_id, role, scope_type, scope_id)
    VALUES (p_user_id, p_role, 'org', p_scope_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_finalize_user_invitation(UUID, TEXT, TEXT, TEXT, public.user_role, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_finalize_user_invitation(UUID, TEXT, TEXT, TEXT, public.user_role, UUID) TO authenticated, service_role;

-- ── 3. fn_user_roles_before_delete_guard ────────────────────────────────
-- The body of 20261118100100 with the bypass condition changed, marked below.

CREATE OR REPLACE FUNCTION public.fn_user_roles_before_delete_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining INT;
  v_session_role TEXT;
BEGIN
  -- Only an actual referential cascade may revoke the deleting manager's
  -- role. No user-controlled GUC can turn off the direct self-revoke guard.
  IF pg_trigger_depth() > 1 AND (
    (OLD.scope_type::text = 'org' AND NOT EXISTS (
      SELECT 1 FROM organizations WHERE id = OLD.scope_id
    )) OR
    (OLD.scope_type::text = 'microgrid' AND NOT EXISTS (
      SELECT 1 FROM microgrids WHERE id = OLD.scope_id
    )) OR
    -- Changed (RFC mgm#197): a deleted tenant's access rows cascade too.
    (OLD.scope_type::text = 'tenant' AND NOT EXISTS (
      SELECT 1 FROM tenants WHERE id = OLD.scope_id
    ))
  ) THEN
    RETURN OLD;
  END IF;
  -- Bypass guards for DB-superuser cascade paths:
  --   - `postgres` (local dev, migration tooling, test harness cleanup)
  --   - `supabase_admin` (Supabase cloud admin operations)
  -- When auth.users is purged externally (admin console / cleanup script),
  -- the ON DELETE CASCADE propagates into user_roles and fires this
  -- trigger. If the purged user happens to be the last super_admin, the
  -- trigger would block the cleanup, leaving orphan auth rows. Bypass is
  -- safe: these roles already have full DB access by definition.
  --
  -- IMPORTANT: use session_user, NOT current_user. Both fn_finalize_user_invitation
  -- and fn_change_user_role are SECURITY DEFINER owned by `postgres`, so
  -- current_user evaluates to 'postgres' inside those function bodies — which
  -- would silently bypass ALL trigger guards (self-revoke + last-super_admin)
  -- for any call via those RPCs. session_user returns the original LOGIN role
  -- (e.g. `authenticated` for normal users) and is NOT changed by SECURITY
  -- DEFINER. The bypass is only triggered when literally connecting as postgres
  -- or supabase_admin (migrations, direct admin operations).
  --
  -- Changed (20261118180000): the login alone is not enough. A connection
  -- that carries an API request (request.jwt.claims set, so auth.role() is
  -- not NULL) is guarded whatever its login, because a PostgREST that logs
  -- in as postgres (the Docker Compose stack) sends every request that way.
  -- Migrations, `supabase db query` and the maintenance scripts set no
  -- claims and keep the bypass. If PostgREST ever stops setting the claims,
  -- revisit.
  v_session_role := session_user;
  IF v_session_role IN ('postgres', 'supabase_admin') AND auth.role() IS NULL THEN
    RETURN OLD;
  END IF;

  -- Self-revocation guard. auth.uid() is NULL for service-role callers; we
  -- intentionally scope this guard to user-bound callers only — the
  -- service role is an out-of-band admin and can force a revoke if it
  -- really needs to (e.g. manual cleanup script). Routes MUST NOT use the
  -- service-role client for user-initiated deletes (documented in the
  -- route comment).
  -- Changed (RFC mgm#197): staff rows only; one's own tenant row may go.
  IF auth.uid() IS NOT NULL AND OLD.user_id = auth.uid()
     AND OLD.scope_type::text <> 'tenant' THEN
    RAISE EXCEPTION 'Cannot revoke your own access. Ask another administrator.'
      USING ERRCODE = '42501';
  END IF;

  -- Last-super_admin guard. If the row being removed is a super_admin row,
  -- and it is the last remaining super_admin row in the table, block.
  -- Counts rows where role='super_admin' excluding the row being deleted.
  IF OLD.role = 'super_admin' THEN
    SELECT COUNT(*) INTO v_remaining
    FROM user_roles
    WHERE role = 'super_admin'
      AND id <> OLD.id;

    IF v_remaining = 0 THEN
      RAISE EXCEPTION 'Cannot revoke the last super admin. Promote another user first.'
        USING ERRCODE = '40000';
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_user_roles_before_delete_guard() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_user_roles_before_delete_guard() TO service_role;
