-- 20261022090000_synthetic_metering_plugin.sql
-- Issue #44 (OSS 14): register the `synthetic-metering` bundled plugin.
-- Design: docs/adr/ADR-005-synthetic-metering-plugin.md.
--
-- Plugin state only. No table is created or altered, and no demonstration
-- data is inserted: the demonstration dataset is an explicit operator script
-- (supabase/scripts/load-synthetic-demo.sql), not a migration.
--
--   1. Whitelist the plugin name (CHECK constraints + fn_mgm_set_plugin_enabled).
--      Adding a bundled plugin requires a versioned migration (see 00056).
--   2. Default OFF. Every other plugin treats a missing mgm_plugins row as
--      "enabled" so deployments need no backfill; a demonstration plugin must
--      not switch itself on. mgm_plugin_enabled_for_org now returns FALSE for
--      a missing synthetic-metering row. All other plugins are unchanged.
--
-- Behavior-preserving for existing deployments: no existing row changes.

ALTER TABLE mgm_plugins
  DROP CONSTRAINT IF EXISTS mgm_plugins_name_known;
ALTER TABLE mgm_plugins
  ADD CONSTRAINT mgm_plugins_name_known CHECK (
    plugin_name IN (
      'organization-directory',
      'community-management',
      'metering',
      'billing',
      'payments',
      'pesapal',
      'synthetic-metering'
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
      'billing',
      'payments',
      'pesapal',
      'synthetic-metering'
    )
  );

CREATE OR REPLACE FUNCTION mgm_plugin_enabled_for_org(_org_id UUID, _plugin_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (
      SELECT enabled
      FROM mgm_plugins
      WHERE org_id = _org_id
        AND plugin_name = _plugin_name
    ),
    _plugin_name <> 'synthetic-metering'
  );
$$;

REVOKE EXECUTE ON FUNCTION mgm_plugin_enabled_for_org(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mgm_plugin_enabled_for_org(UUID, TEXT) TO authenticated, service_role;

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

  IF _plugin_name NOT IN ('organization-directory', 'community-management', 'metering', 'billing', 'payments', 'pesapal', 'synthetic-metering') THEN
    RAISE EXCEPTION 'Unknown plugin: %', _plugin_name
      USING ERRCODE = 'P0001';
  END IF;

  IF _plugin_version IS NULL OR btrim(_plugin_version) = '' THEN
    RAISE EXCEPTION 'Plugin version is required'
      USING ERRCODE = 'P0001';
  END IF;

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
