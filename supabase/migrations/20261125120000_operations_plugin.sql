-- The operations plugin (#133, A2): the plugin that will own investigations
-- of a site's day (ADR-007 decision 3) joins the plugin names, off for every
-- organization until a row turns it on.
--
--  1. 'operations' joins the plugin names: the CHECKs on mgm_plugins and
--     mgm_plugin_audit_log, and fn_mgm_set_plugin_enabled, re-issued in full
--     from 20261118140000 (their latest definition) with the name added, as
--     00059, 00063, 00065 and 20261118140000 did for theirs.
--     fn_mgm_set_plugin_enabled keeps its body, its access check
--     (user_can_access_org, so a tenant cannot switch it) and its grants.
--  2. mgm_plugin_enabled_for_org: operations is off for an organization
--     until a row turns it on, as tenant-app is. Investigations share one
--     installation-wide evidence budget and a retention pass that runs
--     across organizations (ADR-007 decision 3; investigation-evidence.md
--     Q5), so each organization opts in. Every other plugin keeps its
--     answer: tenant-app off, the rest on without a row.
--
-- Nothing reads the plugin's state yet: it owns no table, route, page or
-- view, and the plugin gate is not asked about it by any write. Its tables
-- and the functions that check its state arrive with their first consumer.
-- What does ask about it is the GUI host, which asks about every bundled
-- plugin for each organization it builds a manifest for; it gets false.
--
-- No helper body changes (user_can_access_org, user_can_access_microgrid).
--
-- Running release: the release before this one knows no operations plugin
-- and never asks about it, so no cutover is needed. Until this file runs,
-- mgm_plugin_enabled_for_org answers TRUE for a name it does not list, so
-- nothing may rely on operations being off before it.
--
-- Idempotent: DROP ... IF EXISTS and CREATE OR REPLACE throughout, so a
-- re-run converges on the same state.

-- ── 1. The plugin name ──────────────────────────────────────────────────

ALTER TABLE public.mgm_plugins
  DROP CONSTRAINT IF EXISTS mgm_plugins_name_known;
ALTER TABLE public.mgm_plugins
  ADD CONSTRAINT mgm_plugins_name_known CHECK (
    plugin_name IN (
      'organization-directory',
      'community-management',
      'metering',
      'billing',
      'payments',
      'pesapal',
      'tenant-app',
      'operations'
    )
  );

ALTER TABLE public.mgm_plugin_audit_log
  DROP CONSTRAINT IF EXISTS mgm_plugin_audit_log_plugin_known;
ALTER TABLE public.mgm_plugin_audit_log
  ADD CONSTRAINT mgm_plugin_audit_log_plugin_known CHECK (
    plugin_name IN (
      'organization-directory',
      'community-management',
      'metering',
      'billing',
      'payments',
      'pesapal',
      'tenant-app',
      'operations'
    )
  );

-- The body of 20261118140000 with 'operations' added to the list of names.
-- Turning a plugin on or off still needs organization access
-- (user_can_access_org), so a tenant, who has none, cannot switch it.
CREATE OR REPLACE FUNCTION public.fn_mgm_set_plugin_enabled(
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

  IF _plugin_name NOT IN ('organization-directory', 'community-management', 'metering', 'billing', 'payments', 'pesapal', 'tenant-app', 'operations') THEN
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

-- The SECURITY DEFINER convention (CLAUDE.md), as in 20261118140000. The
-- service role gains nothing by it: the function refuses a caller without
-- auth.uid().
REVOKE EXECUTE ON FUNCTION public.fn_mgm_set_plugin_enabled(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_mgm_set_plugin_enabled(UUID, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;

-- ── 2. operations is off without a row ──────────────────────────────────
--
-- The function of 20261118140000 with 'operations' added to the NOT IN list.
-- The names in that list are the plugins that are off by default. They must
-- be exactly the catalog's plugins with `defaultEnabled: false` in
-- src/lib/plugins/bundled.ts, today tenant-app and operations: Settings →
-- Plugins reads the default there, while the plugin gate, the GUI host and
-- the composers read it here. If a plugin's default changes, change both
-- lists in one commit, in a new migration for this side;
-- src/lib/plugins/__tests__/default-off-plugins.test.ts compares this list
-- with the catalog and fails while they differ. The newest migration that
-- re-issues this function wins, so a later one that adds a default-off
-- plugin must carry both of these names too.
--
-- It still answers any signed-in caller about any organization, with no
-- access check, as 20261118140000 § 2 sets out: tenant-only accounts ask
-- it with their own token (composeTenantApp, through the gate), and what it
-- discloses is one organization's plugin on/off state for an id the caller
-- already has. If an access check is ever added here, let a tenant through
-- for their own unit's organization first, or every tenant is refused.

CREATE OR REPLACE FUNCTION public.mgm_plugin_enabled_for_org(_org_id UUID, _plugin_name TEXT)
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
    _plugin_name NOT IN ('tenant-app', 'operations')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.mgm_plugin_enabled_for_org(UUID, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mgm_plugin_enabled_for_org(UUID, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.mgm_plugin_enabled_for_org(UUID, TEXT) IS
  'Whether a plugin is on for an organization; a missing row answers the plugin''s default (tenant-app and operations off, every other plugin on). Answers any signed-in caller about any organization id, with no access check: tenant-only accounts, which hold no organization access, are among its callers (composeTenantApp asks it with a tenant''s own token). It discloses only that organization''s plugin on/off state, for an id the caller already has, and is not an access check. If an access check is added, let a tenant through for their own unit''s organization first, or every tenant is refused.';
