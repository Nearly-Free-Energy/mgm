-- Tenant app (RFC mgm#197, PR 1), part 2 of 2: what a tenant role row lets
-- its holder read, and how organization managers give and remove it.
--
-- A tenant is someone who rents a unit on a microgrid. From this file a
-- tenant can be a Supabase Auth user holding a user_roles row
-- (user_id, 'tenant', 'tenant', tenants.id), one per unit (RFC decisions 1
-- and 2). Sign-in does not change: fn_auth_sign_in_target sends a link to
-- any address with a role row, which now includes tenants.
--
--  1. user_roles.scope_tenant_id, generated from scope_id for tenant rows,
--     with a foreign key to tenants (ON DELETE CASCADE), as 00052 did for
--     organizations and microgrids. Deleting a tenant, or anything above it,
--     removes the access rows for it.
--  2. user_roles_role_scope_type_consistent gains a tenant branch and an
--     explicit ELSE false. Until now the CASE had no ELSE, so a role it did
--     not list evaluated to NULL and passed; a tenant row on the org scope
--     would then have read as an org row everywhere that filters on
--     scope_type = 'org'. Every existing branch is unchanged, so no existing
--     row can fail it.
--  3. tenant_users goes (decision 2). It was never written; the preflight
--     refuses if a database has rows in it rather than dropping them.
--  4. Two helpers, user_can_access_tenant and user_is_tenant_of_device.
--     Neither includes is_super_admin(): staff read tenants and devices
--     through the existing policies, and these only ever say "your own
--     unit". is_super_admin, user_can_access_org and user_can_access_microgrid
--     are not edited.
--  5. FOR SELECT policies for tenants on tenants, tenant_devices and devices.
--     Postgres ORs them with the existing FOR ALL policies, which do not
--     change. No tenant policy is added on microgrids, edges, communities or
--     organizations: microgrids carries the EMS address and stored
--     credentials, and a policy is row-level, so a tenant could select every
--     column through PostgREST.
--  6. fn_tenant_home: the few microgrid fields a tenant's pages need (name,
--     time zone, currency), without a policy on microgrids.
--  7. fn_tenant_access_grant, fn_tenant_access_revoke, fn_tenant_access_list
--     and fn_tenant_access_count, for organization managers. Org managers
--     cannot read or write other people's role rows through RLS, so these are
--     SECURITY DEFINER and check the caller's access themselves. The grant
--     is the service role's only, with the manager passed as _actor: the
--     access route picks the account from the address the manager typed, so
--     no signed-in caller can name an account by id.
--  8. fn_user_roles_before_delete_guard: a deleted tenant's access rows
--     cascade like a deleted organization's, and giving up one's own unit
--     access is not refused as a self-revocation.
--  9. tenant_access_accounts records every account that has held a tenant
--     row, and fn_list_visible_users leaves out such people unless they hold
--     a staff row, so tenants never appear on the Users page (decision 5),
--     also after their access is removed or their unit deleted.
-- 10. fn_ems_encrypt_secret requires the service role, a staff row, or a
--     direct database session by a member of postgres. Its callers are the
--     staff settings routes; a tenant is a signed-in user with no business
--     encrypting credentials.
--
-- Every column of tenants, tenant_devices and devices is readable by the
-- tenant the row belongs to, because a policy cannot hide columns. That
-- includes tenants.geography_notes, which staff write, and devices.config.
-- CLAUDE.md records this beside the "no tenant policy on microgrids" rule;
-- the tenant RLS suite pins the column lists so a new column fails it.
--
-- Running release: v0.0.9 counts tenant_users on the tenant page and in the
-- delete preview and ignores the error once the table is gone, showing 0, as
-- it always has. The release that ships this file reads the role rows. No
-- cutover is needed.
--
-- Idempotent: IF NOT EXISTS, DROP ... IF EXISTS and CREATE OR REPLACE
-- throughout, so a re-run converges on the same state.

-- ── Preflight ───────────────────────────────────────────────────────────

DO $$
DECLARE
  v_rows BIGINT;
BEGIN
  IF to_regclass('public.tenant_users') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.tenant_users' INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'tenant_users has % row(s). Nothing in MGM writes it, so find out where they came from and move them to tenant role rows before applying this migration.', v_rows;
    END IF;
  END IF;
END;
$$;

-- ── 1. scope_tenant_id ──────────────────────────────────────────────────

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS scope_tenant_id UUID
    GENERATED ALWAYS AS (CASE WHEN scope_type = 'tenant' THEN scope_id END) STORED;

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_tenant_fkey;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_scope_tenant_fkey
  FOREIGN KEY (scope_tenant_id)
  REFERENCES public.tenants(id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS idx_user_roles_scope_tenant_id
  ON public.user_roles(scope_tenant_id);

-- ── 2. Role and scope type go together ─────────────────────────────────

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_scope_type_consistent;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_scope_type_consistent CHECK (
    CASE role
      WHEN 'super_admin'  THEN scope_type = 'org'
      WHEN 'org_manager'  THEN scope_type = 'org'       AND scope_id IS NOT NULL
      WHEN 'ems_operator' THEN scope_type = 'microgrid' AND scope_id IS NOT NULL
      WHEN 'tenant'       THEN scope_type = 'tenant'    AND scope_id IS NOT NULL
      ELSE false
    END
  );

-- ── 3. tenant_users ─────────────────────────────────────────────────────
--
-- No CASCADE: nothing depends on the table, and if something did, this
-- should stop rather than take it along. Its policy and indexes go with it.

DROP TABLE IF EXISTS public.tenant_users;

-- ── 4. Helpers ──────────────────────────────────────────────────────────

-- True iff the caller holds a tenant row for this tenant. Not true for super
-- admins or managers: they read tenants through the existing policies.
CREATE OR REPLACE FUNCTION public.user_can_access_tenant(_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_roles
    WHERE user_id = auth.uid()
      AND role = 'tenant'
      AND scope_type = 'tenant'
      AND scope_id = _tenant_id
  );
$$;

ALTER FUNCTION public.user_can_access_tenant(UUID) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.user_can_access_tenant(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.user_can_access_tenant(UUID) TO authenticated, service_role;

-- True iff the caller holds a tenant row for a tenant that any tenant_devices
-- row links to this device, whatever its effective dates. Reading
-- tenant_devices here, as the definer, keeps the devices policy independent
-- of the RLS on tenant_devices.
--
-- Effective dates are not clipped here: the tenant may see the device row of
-- a meter they held in the past or will hold. Which days of its use they see
-- is the tenant app's job (RFC mgm#197 § 5, PR 3), which clips each
-- assignment to effective_from/effective_to. If a policy on per-day data
-- (meter_readings, billing) is ever written with this helper, revisit: it
-- would show a former tenant the meter's readings after they moved out.
CREATE OR REPLACE FUNCTION public.user_is_tenant_of_device(_device_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM tenant_devices td
    JOIN user_roles ur
      ON ur.scope_id = td.tenant_id
     AND ur.role = 'tenant'
     AND ur.scope_type = 'tenant'
    WHERE td.device_id = _device_id
      AND ur.user_id = auth.uid()
  );
$$;

ALTER FUNCTION public.user_is_tenant_of_device(UUID) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.user_is_tenant_of_device(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.user_is_tenant_of_device(UUID) TO authenticated, service_role;

-- ── 5. What a tenant reads ──────────────────────────────────────────────
--
-- FOR SELECT only, and TO authenticated: a tenant writes nothing in this
-- slice. The SECURITY INVOKER write functions (fn_create_tenant,
-- fn_replace_tenant_device, fn_entity_delete_*) stay closed to tenants only
-- while these policies are SELECT policies; a tenant write policy re-opens
-- that question.

DROP POLICY IF EXISTS "Tenants can read their own tenant" ON public.tenants;
CREATE POLICY "Tenants can read their own tenant"
  ON public.tenants
  FOR SELECT
  TO authenticated
  USING (user_can_access_tenant(id));

DROP POLICY IF EXISTS "Tenants can read their own meter assignments" ON public.tenant_devices;
CREATE POLICY "Tenants can read their own meter assignments"
  ON public.tenant_devices
  FOR SELECT
  TO authenticated
  USING (user_can_access_tenant(tenant_id));

DROP POLICY IF EXISTS "Tenants can read their own devices" ON public.devices;
CREATE POLICY "Tenants can read their own devices"
  ON public.devices
  FOR SELECT
  TO authenticated
  USING (user_is_tenant_of_device(id));

-- ── 6. fn_tenant_home ───────────────────────────────────────────────────
--
-- The tenant's unit and the three microgrid fields its pages need: name,
-- time zone (usage days are built in it, RFC § 5) and currency. Also the
-- tenant's microgrid and organization ids, which the tenant app resolves its
-- plugin gate and stored configuration from (RFC § 3, § 5); neither is
-- secret. Nothing else from microgrids: add a column here only if a tenant
-- may see it, since this function is the tenant's only view of the
-- microgrid. No rows unless the caller holds a tenant row for the tenant.

CREATE OR REPLACE FUNCTION public.fn_tenant_home(_tenant_id UUID)
RETURNS TABLE (
  tenant_id UUID,
  display_name TEXT,
  unit_label TEXT,
  microgrid_id UUID,
  microgrid_name TEXT,
  timezone TEXT,
  currency TEXT,
  organization_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    t.id,
    t.display_name,
    t.unit_label,
    t.microgrid_id,
    m.name,
    m.timezone,
    m.currency,
    c.org_id
  FROM tenants t
  JOIN microgrids m ON m.id = t.microgrid_id
  JOIN communities c ON c.id = m.community_id
  WHERE t.id = _tenant_id
    AND user_can_access_tenant(_tenant_id);
$$;

REVOKE EXECUTE ON FUNCTION public.fn_tenant_home(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_tenant_home(UUID) TO authenticated, service_role;

-- ── 7. Giving and removing access ───────────────────────────────────────
--
-- Who may: anyone user_can_access_microgrid allows for the tenant's
-- microgrid, which is the organization's managers and super admins.
-- Revoke, list and count are called with the manager's own client, and
-- refuse a caller without a session (auth.uid() NULL, the service role
-- included); service_role keeps EXECUTE on them by the grant convention
-- only. The grant is the other way round: the service role only, with the
-- manager as _actor (see its comment).
--
-- These deal in role row ids ("access ids"), not user ids, apart from the
-- grant's input: a manager sees the addresses that can sign in to their
-- unit and needs no account identifier to remove one.
--
-- An unknown tenant is reported as not permitted to everyone but a super
-- admin, because user_can_access_microgrid(NULL) reduces to is_super_admin().

-- Gives the user access to the tenant's data, on behalf of _actor.
-- Idempotent: granting twice returns the same access id.
--
-- The service role's only. The access route (RFC § 6) finds or creates the
-- account from the address the manager typed and passes its id here. A
-- signed-in caller cannot name an account by id, so a manager cannot attach
-- a tenant row to an account they know only by an id they can read (a
-- created_by or actor_user_id column) and then read its address back from
-- fn_tenant_access_list, nor learn from the answer which ids are accounts.
--
-- _actor is the signed-in manager, after the route's getUser(). auth.uid()
-- is NULL for the service role, so _actor is checked here the way
-- user_can_access_org checks auth.uid() for the tenant's organization: a
-- super admin, or an org manager of that organization (fn_payment_reconcile
-- checks its actor the same way). If what user_can_access_org means
-- changes, change this check with it.
--
-- Earlier drafts of this file took (_tenant_id, _user_id) and were callable
-- by authenticated; the DROP keeps a re-run from leaving that version
-- beside this one.
DROP FUNCTION IF EXISTS public.fn_tenant_access_grant(UUID, UUID);

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

-- Service role only, on purpose (above): authenticated is revoked as well
-- as PUBLIC and anon.
REVOKE EXECUTE ON FUNCTION public.fn_tenant_access_grant(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_tenant_access_grant(UUID, UUID, UUID) TO service_role;

-- Removes one access row of the tenant. When the person then holds no role
-- row at all, their sessions are deleted (refresh tokens cascade with them),
-- so their next token refresh fails and they are signed out; it returns true
-- in that case. supabase-js has no admin call that signs out a user by id
-- (auth.admin.signOut takes the user's JWT), so this is done here, as the
-- emergency sign-in runbook does by hand.
--
-- Data access ends at once either way, because every helper reads user_roles
-- live. An access token already issued stays valid until it expires
-- (jwt_expiry, one hour), and while it lasts it reads nothing a role row no
-- longer allows. If MGM ever puts role claims in the access token (the hook
-- in 20261117210000 adds none), revisit: such a token would carry the
-- revoked role until it expires.
CREATE OR REPLACE FUNCTION public.fn_tenant_access_revoke(_tenant_id UUID, _access_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_microgrid UUID;
  v_user UUID;
BEGIN
  SELECT microgrid_id INTO v_microgrid FROM tenants WHERE id = _tenant_id;

  IF auth.uid() IS NULL OR NOT user_can_access_microgrid(v_microgrid) THEN
    RAISE EXCEPTION 'You do not have permission to manage access to this tenant.'
      USING ERRCODE = '42501';
  END IF;
  IF v_microgrid IS NULL THEN
    RAISE EXCEPTION 'Tenant not found.'
      USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM user_roles
  WHERE id = _access_id
    AND role = 'tenant'
    AND scope_type = 'tenant'
    AND scope_id = _tenant_id
  RETURNING user_id INTO v_user;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'This tenant has no such access.'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = v_user) THEN
    RETURN FALSE;
  END IF;

  DELETE FROM auth.sessions WHERE user_id = v_user;
  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_tenant_access_revoke(UUID, UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_tenant_access_revoke(UUID, UUID) TO authenticated, service_role;

-- The addresses that can sign in to the tenant's data, for the tenant record
-- page. user_can_see_user_profile does not cover tenant rows (it reads
-- org-scoped rows only), so this function carries its own check.
CREATE OR REPLACE FUNCTION public.fn_tenant_access_list(_tenant_id UUID)
RETURNS TABLE (access_id UUID, email TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_microgrid UUID;
BEGIN
  SELECT t.microgrid_id INTO v_microgrid FROM tenants t WHERE t.id = _tenant_id;

  IF auth.uid() IS NULL OR NOT user_can_access_microgrid(v_microgrid) THEN
    RAISE EXCEPTION 'You do not have permission to manage access to this tenant.'
      USING ERRCODE = '42501';
  END IF;
  IF v_microgrid IS NULL THEN
    RAISE EXCEPTION 'Tenant not found.'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
    SELECT ur.id, au.email::TEXT, ur.created_at
    FROM user_roles ur
    JOIN auth.users au ON au.id = ur.user_id
    WHERE ur.role = 'tenant'
      AND ur.scope_type = 'tenant'
      AND ur.scope_id = _tenant_id
    ORDER BY ur.created_at, au.email;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_tenant_access_list(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_tenant_access_list(UUID) TO authenticated, service_role;

-- How many access rows the given tenants have, counting only tenants whose
-- microgrid the caller can access. The delete preview uses it: deleting an
-- organization, community or microgrid removes these rows through
-- scope_tenant_id. Unknown or inaccessible tenants count 0.
CREATE OR REPLACE FUNCTION public.fn_tenant_access_count(_tenant_ids UUID[])
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::INTEGER
  FROM user_roles ur
  JOIN tenants t ON t.id = ur.scope_id
  WHERE ur.role = 'tenant'
    AND ur.scope_type = 'tenant'
    AND ur.scope_id = ANY(_tenant_ids)
    AND auth.uid() IS NOT NULL
    AND user_can_access_microgrid(t.microgrid_id);
$$;

REVOKE EXECUTE ON FUNCTION public.fn_tenant_access_count(UUID[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_tenant_access_count(UUID[]) TO authenticated, service_role;

-- ── 8. Role-row delete guard ────────────────────────────────────────────
--
-- The body of 20260926130210 with two changes, marked below:
--  - a tenant row whose tenant is gone is a cascade, like an org or
--    microgrid row whose entity is gone, so a manager who also rents a unit
--    can delete that unit or anything above it;
--  - the self-revocation guard applies to staff rows only. It exists so
--    nobody locks themselves out of administration, which removing one's own
--    unit access cannot do. If a staff role is ever given the tenant scope,
--    revisit.
-- 20261103090000 checked the previous body when it ran; it does not run
-- again, so replacing the body here does not affect it.

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

-- ── 9. Tenants stay off the Users page ──────────────────────────────────
--
-- tenant_access_accounts records each account that has ever held a tenant
-- row. A trigger on user_roles writes it, so every path that adds a tenant
-- row is covered (fn_tenant_access_grant, the service role, a fixture). It
-- outlives the rows on purpose: when access is removed, or the unit deleted
-- (the scope_tenant_id cascade), the person keeps their auth account with no
-- role rows (RFC § 6), and fn_list_visible_users would otherwise list them
-- among staff with no role, as it lists removed staff, with Resend and Edit
-- beside them. The record goes with the auth account.
--
-- Nothing reads it through the API: RLS is on with no policy, and anon and
-- authenticated hold no privilege on it. fn_list_visible_users reads it as
-- the definer.

CREATE TABLE IF NOT EXISTS public.tenant_access_accounts (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  first_granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_access_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_access_accounts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_user_roles_record_tenant_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO tenant_access_accounts (user_id)
    VALUES (NEW.user_id)
    ON CONFLICT (user_id) DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_user_roles_record_tenant_account() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_user_roles_record_tenant_account() TO service_role;

DROP TRIGGER IF EXISTS trg_user_roles_record_tenant_account ON public.user_roles;
CREATE TRIGGER trg_user_roles_record_tenant_account
  AFTER INSERT OR UPDATE OF scope_type ON public.user_roles
  FOR EACH ROW
  WHEN (NEW.scope_type = 'tenant')
  EXECUTE FUNCTION public.fn_user_roles_record_tenant_account();

INSERT INTO public.tenant_access_accounts (user_id)
  SELECT DISTINCT user_id FROM public.user_roles WHERE scope_type = 'tenant'
  ON CONFLICT (user_id) DO NOTHING;

-- fn_list_visible_users: the body of 20261114230100 with one added
-- condition: a person who holds no staff row and holds, or has held, a
-- tenant row is left out. user_can_see_user_profile is true for every
-- account when the caller is a super admin, so without it tenants would be
-- listed on the Users page with no role. A person with no rows who was
-- never a tenant (staff access removed) is still listed, as before, and a
-- manager who also rents is listed once, as a manager.
--
-- So is hidden: someone who was both staff and a tenant and has lost both.
-- They can still be invited again by address (POST /api/users/invite
-- reuses an account with no role rows), which lists them again. If the
-- Users page must show such people, revisit.
--
-- Same signature and columns, so callers and generated types do not
-- change. The condition relies on staff roles being org-scoped (the CHECK
-- in section 2); if a staff role gains another scope type, revisit.

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
    -- Added (RFC mgm#197): tenants, current or former, are not staff.
    AND (
      org_role.role IS NOT NULL
      OR (
        NOT EXISTS (
          SELECT 1 FROM public.user_roles t
          WHERE t.user_id = au.id
            AND t.scope_type = 'tenant'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.tenant_access_accounts ta
          WHERE ta.user_id = au.id
        )
      )
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_list_visible_users(uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_visible_users(uuid[]) TO authenticated, service_role;

-- ── 10. fn_ems_encrypt_secret: staff and the service role ───────────────
--
-- The body of 20261014090000 with a check before the key is read. The
-- callers are the payment-account, email-sender and OpenEMS settings routes,
-- which encrypt as the signed-in manager after authorizing them, and the
-- service role. A staff row is any org-scoped row (super_admin and
-- org_manager, pinned to the org scope by the CHECK in section 2); if a
-- staff role gains another scope type, revisit.
--
-- A session connected straight to the database carries no JWT, so
-- auth.role() and auth.uid() are NULL in it. It passes when its login role
-- is a member of postgres, by membership rather than by name, because the
-- login differs by path: `supabase db reset` and the rehearsal scripts
-- connect as postgres, `supabase db push` as cli_login_postgres (a
-- NOINHERIT member that sets its role to postgres), and key rotation
-- (scripts/credential-key-maintenance.py) over whatever privileged
-- maintenance connection the operator has. PostgREST's login role,
-- authenticator, is not a member, and tenant_access.test.ts asserts that.
-- If migrations or key maintenance ever connect through a role that is not
-- a member of postgres, revisit: this check would refuse them.

CREATE OR REPLACE FUNCTION public.fn_ems_encrypt_secret(p_plaintext TEXT)
RETURNS BYTEA
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dek TEXT;
BEGIN
  -- Added (RFC mgm#197): staff and the service role only.
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT pg_has_role(session_user, 'postgres', 'MEMBER')
     AND NOT EXISTS (
       SELECT 1 FROM user_roles
       WHERE user_id = auth.uid()
         AND scope_type = 'org'
     ) THEN
    RAISE EXCEPTION 'Only MGM staff can encrypt a credential.'
      USING ERRCODE = '42501';
  END IF;

  IF p_plaintext IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_dek
  FROM vault.decrypted_secrets
  WHERE name IN ('mgm_ems_dek', 'mbe_ems_dek')
  ORDER BY (name = 'mgm_ems_dek') DESC
  LIMIT 1;

  IF v_dek IS NULL THEN
    RAISE EXCEPTION 'Credential encryption key (mgm_ems_dek) not found in Vault. See docs/runbooks/dek.md.'
      USING ERRCODE = '55000';
  END IF;

  RETURN extensions.pgp_sym_encrypt(p_plaintext, v_dek);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_ems_encrypt_secret(TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_ems_encrypt_secret(TEXT) TO authenticated, service_role;
