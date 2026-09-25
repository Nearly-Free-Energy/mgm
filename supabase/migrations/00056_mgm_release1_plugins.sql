-- 00056_mgm_release1_plugins.sql
-- Release 1 foundation (issue #3): trusted MGM plugin state, audit trail,
-- fail-closed community-management enforcement, and first-organization bootstrap.
--
-- Expand-only / behavior-preserving for existing deployments:
--   * No existing table is altered.
--   * A missing `mgm_plugins` row means "enabled": current deployments keep
--     working without a data backfill, and disabling a plugin preserves rows.
--   * Reads remain available while a plugin is disabled; only INSERT, UPDATE,
--     and DELETE on community-management tables are rejected.
--   * `current_user = 'service_role'` is exempt from the trigger. That is a
--     structural exemption, not a circumstantial one: PostgREST switches to
--     the request role per call while `session_user` remains `authenticator`,
--     so `current_user` is the role signal here. service_role already
--     bypasses RLS and is the out-of-band administrative path. User-initiated
--     application writes use the authenticated role and remain gated.
--
-- Trusted plugin names are enumerated in the CHECK constraint below. Adding a
-- future bundled plugin requires a new versioned migration; do not insert
-- arbitrary plugin names.
--
-- Migration rehearsal: `supabase db reset` replays this file after the schema
-- it depends on. For production upgrades, rehearse against a restored backup
-- before applying: the trigger defaults to enabled when no state row exists,
-- so currently stored community, microgrid, and household rows remain readable
-- and writable until an operator explicitly disables the plugin.

-- ── 1. Plugin state ─────────────────────────────────────────────────────────

CREATE TABLE mgm_plugins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plugin_name TEXT NOT NULL,
  version TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, plugin_name),
  CONSTRAINT mgm_plugins_name_known CHECK (
    plugin_name IN ('organization-directory', 'community-management')
  )
);

CREATE INDEX idx_mgm_plugins_org_id ON mgm_plugins(org_id);

ALTER TABLE mgm_plugins ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_mgm_plugins_updated_at ON mgm_plugins;
CREATE TRIGGER trg_mgm_plugins_updated_at
  BEFORE UPDATE ON mgm_plugins
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

-- ── 2. Plugin audit log ─────────────────────────────────────────────────────

CREATE TABLE mgm_plugin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plugin_name TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_enabled BOOLEAN,
  new_enabled BOOLEAN NOT NULL,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mgm_plugin_audit_log_plugin_known CHECK (
    plugin_name IN ('organization-directory', 'community-management')
  ),
  CONSTRAINT mgm_plugin_audit_log_action_known CHECK (
    action IN ('enabled', 'disabled')
  )
);

CREATE INDEX idx_mgm_plugin_audit_log_org_created_at
  ON mgm_plugin_audit_log (org_id, created_at DESC);

ALTER TABLE mgm_plugin_audit_log ENABLE ROW LEVEL SECURITY;

-- ── 3. RLS ──────────────────────────────────────────────────────────────────
--
-- Plugin state is organization-scoped configuration. Organization access is the
-- permission; plugin enablement is the feature gate checked by application
-- routes, navigation, and the trigger below.

DROP POLICY IF EXISTS mgm_plugins_select ON mgm_plugins;
CREATE POLICY mgm_plugins_select ON mgm_plugins FOR SELECT
  USING (is_super_admin() OR user_can_access_org(org_id));

DROP POLICY IF EXISTS mgm_plugins_insert ON mgm_plugins;
CREATE POLICY mgm_plugins_insert ON mgm_plugins FOR INSERT
  WITH CHECK (is_super_admin() OR user_can_access_org(org_id));

DROP POLICY IF EXISTS mgm_plugins_update ON mgm_plugins;
CREATE POLICY mgm_plugins_update ON mgm_plugins FOR UPDATE
  USING (is_super_admin() OR user_can_access_org(org_id))
  WITH CHECK (is_super_admin() OR user_can_access_org(org_id));

-- No DELETE policy. Plugin rows are configuration history anchors; disabling
-- preserves the row. Organization deletion cascades through the FK.
GRANT SELECT, INSERT, UPDATE ON mgm_plugins TO authenticated;

DROP POLICY IF EXISTS mgm_plugin_audit_log_select ON mgm_plugin_audit_log;
CREATE POLICY mgm_plugin_audit_log_select ON mgm_plugin_audit_log FOR SELECT
  USING (is_super_admin() OR user_can_access_org(org_id));

DROP POLICY IF EXISTS mgm_plugin_audit_log_insert ON mgm_plugin_audit_log;
CREATE POLICY mgm_plugin_audit_log_insert ON mgm_plugin_audit_log FOR INSERT
  WITH CHECK (is_super_admin() OR user_can_access_org(org_id));

-- No UPDATE or DELETE policy: plugin changes are append-only history.
GRANT SELECT, INSERT ON mgm_plugin_audit_log TO authenticated;

-- ── 4. Plugin-state helper ──────────────────────────────────────────────────

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
    TRUE
  );
$$;

REVOKE EXECUTE ON FUNCTION mgm_plugin_enabled_for_org(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mgm_plugin_enabled_for_org(UUID, TEXT) TO authenticated, service_role;

-- ── 5. Fail-closed community-management trigger ─────────────────────────────
--
-- SECURITY INVOKER (not DEFINER): the trigger runs as the writing caller, so
-- RLS on parent tables still applies to the org-resolution SELECTs below. A
-- caller who cannot see the parent cannot resolve an org here; the domain-table
-- RLS policy then denies the write independently.
--
-- Postgres does not expose a trigger function as RPC, so no EXECUTE grant dance
-- applies here.

CREATE OR REPLACE FUNCTION fn_mgm_require_community_plugin_enabled()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id UUID;
  v_other_org_id UUID;
BEGIN
  -- Structural service-role exemption: service_role bypasses RLS by design.
  -- This trigger declines to add a restriction to that administrative path.
  -- Check current_user (not session_user): PostgREST connects as
  -- authenticator and switches to the request role per call.
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'communities' THEN
    IF TG_OP = 'DELETE' THEN
      v_org_id := OLD.org_id;
    ELSIF TG_OP = 'INSERT' THEN
      v_org_id := NEW.org_id;
    ELSE
      v_org_id := NEW.org_id;
      v_other_org_id := OLD.org_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'microgrids' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT org_id INTO v_org_id
      FROM communities
      WHERE id = OLD.community_id;
    ELSE
      SELECT org_id INTO v_org_id
      FROM communities
      WHERE id = NEW.community_id;
      IF TG_OP = 'UPDATE' THEN
        SELECT org_id INTO v_other_org_id
        FROM communities
        WHERE id = OLD.community_id;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'households' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT c.org_id INTO v_org_id
      FROM microgrids m
      JOIN communities c ON c.id = m.community_id
      WHERE m.id = OLD.microgrid_id;
    ELSE
      SELECT c.org_id INTO v_org_id
      FROM microgrids m
      JOIN communities c ON c.id = m.community_id
      WHERE m.id = NEW.microgrid_id;
      IF TG_OP = 'UPDATE' THEN
        SELECT c.org_id INTO v_other_org_id
        FROM microgrids m
        JOIN communities c ON c.id = m.community_id
        WHERE m.id = OLD.microgrid_id;
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'fn_mgm_require_community_plugin_enabled is bound to an unexpected table: %', TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  -- A missing parent is left to FK/RLS handling. The trigger only gates writes
  -- whose organization scope it can resolve.
  IF v_org_id IS NOT NULL
    AND NOT mgm_plugin_enabled_for_org(v_org_id, 'community-management')
  THEN
    RAISE EXCEPTION 'community-management plugin is disabled for this organization'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE'
    AND v_other_org_id IS NOT NULL
    AND v_other_org_id IS DISTINCT FROM v_org_id
    AND NOT mgm_plugin_enabled_for_org(v_other_org_id, 'community-management')
  THEN
    RAISE EXCEPTION 'community-management plugin is disabled for this organization'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mgm_require_community_plugin_enabled_communities ON communities;
CREATE TRIGGER trg_mgm_require_community_plugin_enabled_communities
  BEFORE INSERT OR UPDATE OR DELETE ON communities
  FOR EACH ROW
  EXECUTE FUNCTION fn_mgm_require_community_plugin_enabled();

DROP TRIGGER IF EXISTS trg_mgm_require_community_plugin_enabled_microgrids ON microgrids;
CREATE TRIGGER trg_mgm_require_community_plugin_enabled_microgrids
  BEFORE INSERT OR UPDATE OR DELETE ON microgrids
  FOR EACH ROW
  EXECUTE FUNCTION fn_mgm_require_community_plugin_enabled();

DROP TRIGGER IF EXISTS trg_mgm_require_community_plugin_enabled_households ON households;
CREATE TRIGGER trg_mgm_require_community_plugin_enabled_households
  BEFORE INSERT OR UPDATE OR DELETE ON households
  FOR EACH ROW
  EXECUTE FUNCTION fn_mgm_require_community_plugin_enabled();

-- ── 6. Atomic plugin toggle ─────────────────────────────────────────────────
--
-- SECURITY DEFINER so the state UPSERT and audit INSERT share one atomic
-- transaction. The caller's organization access is checked explicitly in the
-- body; the function never trusts application-layer role state.

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

  IF _plugin_name NOT IN ('organization-directory', 'community-management') THEN
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

-- ── 7. First-organization bootstrap ─────────────────────────────────────────
--
-- Creates the initial organization and grants the calling authenticated user
-- the organization-manager role. The table lock plus existence check make
-- concurrent first-run calls safe: only the first transaction creates the org.
-- The application additionally requires MGM_BOOTSTRAP_TOKEN; this function
-- enforces the complementary database invariant (exactly one first org).

CREATE OR REPLACE FUNCTION fn_mgm_bootstrap_first_organization(
  _name TEXT,
  _address_city TEXT,
  _address_country TEXT,
  _organization_directory_version TEXT,
  _community_management_version TEXT,
  _address_line1 TEXT DEFAULT NULL,
  _address_line2 TEXT DEFAULT NULL,
  _address_region TEXT DEFAULT NULL,
  _address_postal_code TEXT DEFAULT NULL
)
RETURNS organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org organizations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  IF _name IS NULL OR btrim(_name) = '' THEN
    RAISE EXCEPTION 'Name is required'
      USING ERRCODE = 'P0001';
  END IF;
  IF _address_city IS NULL OR btrim(_address_city) = '' THEN
    RAISE EXCEPTION 'City is required'
      USING ERRCODE = 'P0001';
  END IF;
  IF _address_country IS NULL OR btrim(_address_country) = '' THEN
    RAISE EXCEPTION 'Country is required'
      USING ERRCODE = 'P0001';
  END IF;

  LOCK TABLE organizations IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (SELECT 1 FROM organizations) THEN
    RAISE EXCEPTION 'An organization already exists'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO organizations (
    name,
    address_line1,
    address_line2,
    address_city,
    address_region,
    address_country,
    address_postal_code
  )
  VALUES (
    btrim(_name),
    NULLIF(btrim(COALESCE(_address_line1, '')), ''),
    NULLIF(btrim(COALESCE(_address_line2, '')), ''),
    btrim(_address_city),
    NULLIF(btrim(COALESCE(_address_region, '')), ''),
    btrim(_address_country),
    NULLIF(btrim(COALESCE(_address_postal_code, '')), '')
  )
  RETURNING * INTO v_org;

  INSERT INTO user_roles (user_id, role, scope_type, scope_id)
  VALUES (auth.uid(), 'org_manager', 'org', v_org.id)
  ON CONFLICT DO NOTHING;

  INSERT INTO mgm_plugins (org_id, plugin_name, version, enabled)
  VALUES
    (v_org.id, 'organization-directory', btrim(_organization_directory_version), TRUE),
    (v_org.id, 'community-management', btrim(_community_management_version), TRUE)
  ON CONFLICT DO NOTHING;

  RETURN v_org;
END;
$$;

REVOKE EXECUTE ON FUNCTION fn_mgm_bootstrap_first_organization(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_mgm_bootstrap_first_organization(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
