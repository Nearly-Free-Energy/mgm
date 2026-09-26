-- Restore RPCs called by released MGM management deletion routes.
-- SECURITY INVOKER preserves table RLS; anonymous execution is denied.
CREATE OR REPLACE FUNCTION fn_user_roles_before_delete_guard()
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
  v_session_role := session_user;
  IF v_session_role IN ('postgres', 'supabase_admin') THEN
    RETURN OLD;
  END IF;

  -- Self-revocation guard. auth.uid() is NULL for service-role callers; we
  -- intentionally scope this guard to user-bound callers only — the
  -- service role is an out-of-band admin and can force a revoke if it
  -- really needs to (e.g. manual cleanup script). Routes MUST NOT use the
  -- service-role client for user-initiated deletes (documented in the
  -- route comment).
  IF auth.uid() IS NOT NULL AND OLD.user_id = auth.uid() THEN
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

CREATE OR REPLACE FUNCTION fn_entity_delete_org(p_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE v_deleted INT;
BEGIN
  DELETE FROM organizations WHERE id = p_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_entity_delete_org(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_entity_delete_org(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION fn_entity_delete_community(p_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE v_deleted INT;
BEGIN
  DELETE FROM communities WHERE id = p_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_entity_delete_community(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_entity_delete_community(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION fn_entity_delete_microgrid(p_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE v_deleted INT;
BEGIN
  DELETE FROM microgrids WHERE id = p_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_entity_delete_microgrid(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_entity_delete_microgrid(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION fn_entity_delete_edge(p_id UUID)
RETURNS INT LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE v_deleted INT;
BEGIN
  DELETE FROM edges WHERE id = p_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
REVOKE EXECUTE ON FUNCTION fn_entity_delete_edge(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_entity_delete_edge(UUID) TO authenticated, service_role;
