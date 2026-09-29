-- 00063_billing_plugin.sql
-- Release 3 (issue #5): register the `billing` bundled plugin.
--
-- The trusted plugin-name CHECK constraints from 00056/00059 enumerate
-- exactly three names. Release 3 adds the fourth (`billing`, defined in
-- src/lib/plugins/bundled.ts). DROP + ADD both constraints so pilot-chain
-- and full-chain databases converge; the permitted set stays closed —
-- adding a future plugin requires another versioned migration.

ALTER TABLE mgm_plugins
  DROP CONSTRAINT IF EXISTS mgm_plugins_name_known;
ALTER TABLE mgm_plugins
  ADD CONSTRAINT mgm_plugins_name_known CHECK (
    plugin_name IN (
      'organization-directory',
      'community-management',
      'metering',
      'billing'
    )
  );

ALTER TABLE mgm_plugin_audit_log
  DROP CONSTRAINT IF EXISTS mgm_plugin_audit_log_plugin_known;
ALTER TABLE mgm_plugin_audit_log
  ADD CONSTRAINT mgm_plugin_audit_log_plugin_known CHECK (
    plugin_name IN (
      'organization-directory',
      'community-management',
      'metering',
      'billing'
    )
  );

-- ── Toggle RPC whitelist ────────────────────────────────────────────────────
--
-- The CHECK constraints above are not sufficient: fn_mgm_set_plugin_enabled
-- (00056, redefined in 00059) enforces its own trusted-name whitelist in
-- the body, which still rejects every name except the first three.
-- Redefine it here with the expanded set so Billing is actually toggleable
-- through Settings. Body is otherwise byte-identical to 00059. The core
-- lock (organization-directory) and dependency validation (application
-- layer, src/lib/plugins/bundled.ts) are unchanged.

CREATE OR REPLACE FUNCTION fn_mgm_set_plugin_enabled(
  _org_id UUID,
  _plugin_name TEXT,
  _plugin_version TEXT,
  _enabled BOOLEAN
)
RETURNS mgm_plugins
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous BOOLEAN;
  v_row mgm_plugins%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  IF NOT user_can_access_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized to change plugins for this organization'
      USING ERRCODE = '42501';
  END IF;

  IF _plugin_name NOT IN ('organization-directory', 'community-management', 'metering', 'billing') THEN
    RAISE EXCEPTION 'Unknown plugin: %', _plugin_name
      USING ERRCODE = 'P0001';
  END IF;

  IF _plugin_version IS NULL OR btrim(_plugin_version) = '' THEN
    RAISE EXCEPTION 'Plugin version is required'
      USING ERRCODE = 'P0001';
  END IF;

  -- organization-directory is the platform core: it owns organizations, users,
  -- and this plugin surface itself. It cannot be disabled.
  IF _plugin_name = 'organization-directory' AND NOT _enabled THEN
    RAISE EXCEPTION 'organization-directory cannot be disabled'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT enabled INTO v_previous
  FROM mgm_plugins
  WHERE org_id = _org_id
    AND plugin_name = _plugin_name;

  INSERT INTO mgm_plugins (org_id, plugin_name, version, enabled)
  VALUES (_org_id, _plugin_name, btrim(_plugin_version), _enabled)
  ON CONFLICT (org_id, plugin_name)
  DO UPDATE SET
    version = EXCLUDED.version,
    enabled = EXCLUDED.enabled,
    updated_at = now()
  RETURNING * INTO v_row;

  INSERT INTO mgm_plugin_audit_log (
    org_id,
    plugin_name,
    action,
    previous_enabled,
    new_enabled,
    actor_user_id
  )
  VALUES (
    _org_id,
    _plugin_name,
    CASE WHEN _enabled THEN 'enabled' ELSE 'disabled' END,
    v_previous,
    _enabled,
    auth.uid()
  );

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_mgm_set_plugin_enabled(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_mgm_set_plugin_enabled(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;
