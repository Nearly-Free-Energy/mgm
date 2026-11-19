-- Tenant app (RFC mgm#197, PR 2): the tenant-app plugin in the database, a
-- record of the accounts that have held staff access, and what the Users
-- page does with that record.
--
-- Staff, here and in staff_access_accounts, is not a role (user_role has no
-- staff value): it means holding a user_roles row whose role is not tenant,
-- now. staff_access_accounts records history: accounts that have ever held
-- such a row. src/lib/roles.ts holds the definition.
--
--  1. 'tenant-app' (alias tenant) joins the plugin names: the CHECKs on
--     mgm_plugins and mgm_plugin_audit_log, and fn_mgm_set_plugin_enabled,
--     re-issued in full from 00065 (its latest definition) with the name
--     added, as 00059, 00063 and 00065 did for theirs.
--  2. mgm_plugin_enabled_for_org: tenant-app is off for an organization
--     until a row turns it on. An operator turns it on for each organization
--     whose tenants get the app (RFC § 3), so a missing row must not give
--     every organization's tenants an app nobody switched on. Every other
--     plugin keeps 00056's rule, a missing row means enabled, so nothing that
--     runs today changes, the community-management trigger included.
--  3. staff_access_accounts records every account that holds or has held a
--     role row other than tenant (super_admin, org_manager, ems_operator),
--     as tenant_access_accounts (20261118100100) does for tenant rows: a
--     trigger on user_roles writes it, and this file backfills it. Only
--     fn_list_visible_users reads it, and only for accounts with no rows.
--     It has no effect on what a person may do.
--  4. fn_tenant_access_grant keeps 20261118100100's body: tenant access does
--     not depend on organization roles, so the grant decides only the
--     actor's authority, the unit and the account. A person may hold both,
--     and a person whose staff rows are removed is a tenant like any other.
--  5. fn_list_visible_users also lists anyone holding an ems_operator row,
--     and an account with no rows that has held a staff row (PR 1 review),
--     so a staff account whose rows are all gone stays on the Users page
--     even if it once held tenant access. Anyone holding tenant rows and no
--     staff row is left out, whatever they held before.
--  6. user_is_tenant_of_device keeps its behaviour (PR 1 review): a former
--     tenant still reads the device row of a meter that moved away, which
--     the tenant app needs to show the days before the move. A comment on
--     the function records why that is safe and what would change it.
--
-- Running release: the release before this one knows no tenant-app plugin
-- and never asks about it, nothing calls fn_tenant_access_grant yet (the
-- access route is RFC PR 5), and everyone fn_list_visible_users adds has
-- held tenant access, which only that route will grant. No cutover is
-- needed.
--
-- Idempotent: DROP ... IF EXISTS, CREATE OR REPLACE, IF NOT EXISTS and
-- ON CONFLICT DO NOTHING throughout, so a re-run converges on the same
-- state (see the backfill in section 3 for its one qualification).

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
      'tenant-app'
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
      'tenant-app'
    )
  );

-- The body of 00065 with 'tenant-app' added to the list of names. Turning a
-- plugin on or off still needs organization access (user_can_access_org),
-- so a tenant, who has none, cannot switch the tenant app for their own
-- organization.
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

  IF _plugin_name NOT IN ('organization-directory', 'community-management', 'metering', 'billing', 'payments', 'pesapal', 'tenant-app') THEN
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

-- 00065 granted EXECUTE to authenticated only; this follows the
-- SECURITY DEFINER convention (CLAUDE.md). The service role gains nothing
-- by it: the function refuses a caller without auth.uid().
REVOKE EXECUTE ON FUNCTION public.fn_mgm_set_plugin_enabled(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_mgm_set_plugin_enabled(UUID, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;

-- ── 2. tenant-app is off without a row ──────────────────────────────────
--
-- The function of 00056 with one change: a missing row answers the plugin's
-- default instead of TRUE. The names in the NOT IN list are the plugins that
-- are off by default. They must be exactly the catalog's plugins with
-- `defaultEnabled: false` in src/lib/plugins/bundled.ts, today tenant-app
-- only: Settings → Plugins reads the default there, while the plugin gate,
-- the GUI host and the composers read it here. If a plugin's default
-- changes, change both lists in one commit, in a new migration for this
-- side; src/lib/plugins/__tests__/default-off-plugins.test.ts compares this
-- list with the catalog and fails while they differ.
--
-- It still answers any signed-in caller about any organization, with no
-- access check, as in 00056. Its callers now include tenant-only accounts,
-- which hold no organization access and can ask about any organization id:
-- composeTenantApp asks it, through the gate, with a tenant's own token
-- about the tenant's organization, whose mgm_plugins rows the tenant cannot
-- read. What that discloses is one organization's plugin on/off state, for
-- an id the caller already has; the answer is not an access check, and who
-- may act in the organization is decided elsewhere. If an access check is
-- ever added here, let a tenant through for their own unit's organization
-- first (as user_can_access_tenant and fn_tenant_home decide it), or every
-- tenant is refused. The comment below puts the same on the function.

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
    _plugin_name NOT IN ('tenant-app')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.mgm_plugin_enabled_for_org(UUID, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mgm_plugin_enabled_for_org(UUID, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.mgm_plugin_enabled_for_org(UUID, TEXT) IS
  'Whether a plugin is on for an organization; a missing row answers the plugin''s default (tenant-app off, every other plugin on). Answers any signed-in caller about any organization id, with no access check: tenant-only accounts, which hold no organization access, are among its callers (composeTenantApp asks it with a tenant''s own token). It discloses only that organization''s plugin on/off state, for an id the caller already has, and is not an access check. If an access check is added, let a tenant through for their own unit''s organization first, or every tenant is refused.';

-- ── 3. The accounts that have held staff access ─────────────────────────
--
-- History, not who is staff now: one row per account that holds or has
-- ever held a user_roles row whose role is not tenant. A trigger on
-- user_roles writes it, so every path that adds a staff row is covered
-- (first-run setup, fn_finalize_user_invitation, fn_change_user_role, the
-- service role, a fixture). It outlives the rows on purpose, as
-- tenant_access_accounts does: DELETE /api/users/[id] removes a person's
-- staff rows and keeps their account. The record goes with the auth
-- account.
--
-- Its one reader is fn_list_visible_users (section 5), and only for an
-- account that holds no row at all: there it tells a former staff member,
-- who stays listed, from a former tenant who was never staff, who does not.
-- The record has no effect on what a person may do: it grants nothing and
-- refuses nothing (fn_tenant_access_grant, sign-in and every access check
-- read the rows held now), and decides only whether an account with no rows
-- is listed on the Users page. Whether someone is staff now is read from
-- their rows, never from here; if anything starts reading this table as
-- current staff, or to allow or refuse anything, revisit.
--
-- "Not tenant" rather than a list of staff roles, so a staff role added
-- later is counted without touching this file. If a second role that is not
-- staff is ever added (another customer-facing role), revisit: it would be
-- counted as staff here.
--
-- Nothing reads it through the API: RLS is on with no policy, and anon and
-- authenticated hold no privilege on it. fn_list_visible_users reads it as
-- the definer.

CREATE TABLE IF NOT EXISTS public.staff_access_accounts (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  first_recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.staff_access_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_access_accounts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_user_roles_record_staff_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO staff_access_accounts (user_id)
    VALUES (NEW.user_id)
    ON CONFLICT (user_id) DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_user_roles_record_staff_account() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_user_roles_record_staff_account() TO service_role;

DROP TRIGGER IF EXISTS trg_user_roles_record_staff_account ON public.user_roles;
CREATE TRIGGER trg_user_roles_record_staff_account
  AFTER INSERT OR UPDATE OF role, scope_type ON public.user_roles
  FOR EACH ROW
  WHEN (NEW.role <> 'tenant')
  EXECUTE FUNCTION public.fn_user_roles_record_staff_account();

-- Backfill, part 1: every account holding a staff row now.
INSERT INTO public.staff_access_accounts (user_id)
  SELECT DISTINCT user_id FROM public.user_roles WHERE role <> 'tenant'
  ON CONFLICT (user_id) DO NOTHING;

-- Backfill, part 2: every account with no role row that has never held a
-- tenant row. Until this file an account came into being only as staff (the
-- first-run setup, an invitation, or an operator by hand): sign-in refuses
-- an address without a role row, and nothing grants tenant access yet. So
-- such an account is a former staff member, whose rows DELETE
-- /api/users/[id] removed, and the Users page lists it today. Nothing else
-- records who held a staff row before this table existed. From here on the
-- trigger keeps the record, and an account the tenant access route creates
-- is not in it. On a re-run this part again records each account that then
-- has no row and no tenant history, which, outside the moment between the
-- access route creating an account and granting it access, is again a
-- former staff member. Recording one of those by mistake changes nothing
-- for them while they hold a row: the record counts only for an account
-- with no rows (section 5), so it would list them again after their last
-- unit is revoked. Being recorded, rightly or not, has no effect on what a
-- person may do; it decides only whether an account with no rows is listed.
INSERT INTO public.staff_access_accounts (user_id)
  SELECT au.id
  FROM auth.users au
  WHERE NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = au.id)
    AND NOT EXISTS (SELECT 1 FROM public.tenant_access_accounts ta WHERE ta.user_id = au.id)
  ON CONFLICT (user_id) DO NOTHING;

-- ── 4. The tenant grant does not look at staff rows ─────────────────────
--
-- Re-issued with the body of 20261118100100, unchanged, so a database that
-- ran an earlier draft of this file, which refused staff accounts here,
-- converges on it. Tenant access is a person's access to the units they
-- rent, and does not depend on organization roles: the grant decides only
-- whether the actor may manage access to the unit, whether the unit exists
-- and whether the account does. So a person may hold both, a manager who
-- rents may be given the unit on the same address, and a person whose
-- staff rows are removed (DELETE /api/users/[id], an organization's
-- deletion, the service role) is a tenant like any other, given further
-- units in the same way.
--
-- The PR 1 review's concern, that a staff account could vanish from the
-- Users page as a former tenant, is met by section 5 rather than by
-- refusing grants: current staff are listed through their own rows, and an
-- account left with no rows is listed if it has ever held a staff row.

CREATE OR REPLACE FUNCTION public.fn_tenant_access_grant(_tenant_id UUID, _user_id UUID, _actor UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org UUID;
  v_access UUID;
BEGIN
  SELECT c.org_id INTO v_org
  FROM tenants t
  JOIN microgrids m ON m.id = t.microgrid_id
  JOIN communities c ON c.id = m.community_id
  WHERE t.id = _tenant_id;

  IF _actor IS NULL OR NOT EXISTS (
    SELECT 1
    FROM user_roles ur
    WHERE ur.user_id = _actor
      AND (
        ur.role = 'super_admin'
        OR (ur.role = 'org_manager' AND ur.scope_type = 'org' AND ur.scope_id = v_org)
      )
  ) THEN
    RAISE EXCEPTION 'You do not have permission to manage access to this tenant.'
      USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Tenant not found.'
      USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = _user_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'User not found.'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO user_roles (user_id, role, scope_type, scope_id)
    VALUES (_user_id, 'tenant', 'tenant', _tenant_id)
    ON CONFLICT (user_id, role, scope_type, scope_id) DO NOTHING
    RETURNING id INTO v_access;

  IF v_access IS NULL THEN
    SELECT id INTO v_access
    FROM user_roles
    WHERE user_id = _user_id
      AND role = 'tenant'
      AND scope_type = 'tenant'
      AND scope_id = _tenant_id;
  END IF;

  RETURN v_access;
END;
$$;

-- Service role only, as in 20261118100100: authenticated is revoked as well
-- as PUBLIC and anon.
REVOKE EXECUTE ON FUNCTION public.fn_tenant_access_grant(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_tenant_access_grant(UUID, UUID, UUID) TO service_role;

-- ── 5. The Users page lists staff, and accounts left with no rows ───────
--
-- fn_list_visible_users: the body of 20261118100100 with the added
-- condition changed, marked below. A person is listed (where
-- user_can_see_user_profile lets the caller see them at all) when they:
--  - hold an org-scoped row (super_admin, org_manager), as before, whatever
--    tenant rows they also hold;
--  - hold an ems_operator row, which is staff on the microgrid scope (none
--    ship today, #321, but a row of one must not read as a tenant); or
--  - hold no row at all and either have held a staff row
--    (staff_access_accounts) or have never held a tenant row. The first is
--    the change from 20261118100100, which hid someone who was both staff
--    and a tenant and lost both; they are listed again, with no role. The
--    second is as before: people whose staff access was removed before
--    section 3 existed, and new invitees.
-- Left out: anyone holding tenant rows and no staff row, whatever they held
-- before. A manager whose staff role is removed while they rent is then a
-- tenant like any other, off the list until their last unit goes. Also
-- left out, as before: former tenants with no rows who were never staff.
--
-- "Holds no tenant row" stands for "holds no row at all" in the third case
-- only because the first two have already ruled out org and ems_operator
-- rows, and user_roles_role_scope_type_consistent (20261118100100) pins
-- super_admin and org_manager to 'org', ems_operator to 'microgrid' and
-- tenant to 'tenant'. If that CHECK changes, or a staff role gains another
-- scope type, revisit this condition.
--
-- Who sees the difference: super admins only. user_can_see_user_profile
-- (00012) already hides from an org manager anyone without an org row in
-- their organization, so nobody this condition adds or removes was ever on
-- an org manager's list. The same function names actors elsewhere: the
-- billing audit log, the "entered by" name on invoice PDFs, the
-- billing-period page and the API tokens page's creators. So a former
-- manager who now only rents is unnamed there for super admins too, as on
-- main before this file, which listed no one holding a tenant row and no
-- staff row either.
--
-- Same signature and columns, so callers and generated types do not change.

CREATE OR REPLACE FUNCTION public.fn_list_visible_users(_target_user_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(user_id uuid, email text, email_confirmed_at timestamp with time zone, last_sign_in_at timestamp with time zone, first_name text, last_name text, phone text, role user_role, scope_type role_scope_type, scope_id uuid, ems_operator_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- At most one org-scoped row per user by construction (fn_change_user_role
  -- replaces rather than appends on the org path). super_admin is ordered
  -- first defensively so a user carrying both surfaces as super_admin, which
  -- is what the users list means by "role".
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
      AND ur2.role = 'ems_operator'
  ) ems ON TRUE
  WHERE user_can_see_user_profile(au.id)
    AND (_target_user_ids IS NULL OR au.id = ANY(_target_user_ids))
    -- Staff now are listed; a tenant with no staff row is not (RFC mgm#197,
    -- PR 1); an account with no rows is listed if it was ever staff or never
    -- a tenant (changed in PR 2: the ems_operator and staff_access_accounts
    -- terms).
    AND (
      org_role.role IS NOT NULL
      OR COALESCE(ems.cnt, 0) > 0
      OR (
        NOT EXISTS (
          SELECT 1 FROM public.user_roles t
          WHERE t.user_id = au.id
            AND t.scope_type = 'tenant'
        )
        AND (
          EXISTS (
            SELECT 1 FROM public.staff_access_accounts sa
            WHERE sa.user_id = au.id
          )
          OR NOT EXISTS (
            SELECT 1 FROM public.tenant_access_accounts ta
            WHERE ta.user_id = au.id
          )
        )
      )
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_list_visible_users(uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_visible_users(uuid[]) TO authenticated, service_role;

-- ── 6. user_is_tenant_of_device stays as it is ──────────────────────────
--
-- Not re-issued: its body (20261118100100) is unchanged. It ignores
-- effective dates, so a former tenant of a meter still reads that meter's
-- devices row after it moves to another tenant. That is kept on purpose:
-- the tenant app shows a tenant the days a meter was theirs, including the
-- days before a move (RFC § 5, PR 3), and needs the device row to do it.
-- It is safe only while every devices column is one a former tenant of the
-- meter may read; tenant_access.test.ts pins the column list a tenant reads,
-- so a new column fails it until someone has decided. The comment below
-- puts the same on the function, where \df+ and Studio show it.

COMMENT ON FUNCTION public.user_is_tenant_of_device(UUID) IS
  'RFC mgm#197. True iff the caller holds a tenant row for a tenant that any tenant_devices row links to the device, whatever its effective dates, so a former tenant of a meter keeps reading its devices row after the meter moves; the tenant app uses that to show the days before a move. Safe only while every devices column may be read by a former tenant of the meter: tenant_access.test.ts pins the columns. Revisit before adding a devices column a former tenant may not read, or before writing a policy on per-day data (meter_readings, billing) with this helper.';
