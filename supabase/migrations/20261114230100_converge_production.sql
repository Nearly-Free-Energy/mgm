-- Converge NFE's production database on the migration chain, part 2 of 2.
--
-- Production was built from the base migrations, the pilot overlay and
-- selected later files. 20261114222000 brought the chain's privileges down to
-- production's; this file brings production up to everything else the chain
-- has, so that afterwards the two schemas are the same and `supabase db push`
-- can manage production (mgm-operations, runbooks/apply-migrations.md).
--
-- On a database built from the chain, every statement here is a no-op: each
-- object already exists with this definition, and the drops find nothing.
-- Production gets the file through `supabase db query --remote=<ref> -f
-- <file>`, after 20261114230000, then `supabase migration repair` records the
-- whole chain as applied. Rehearsed on a schema-only copy of production on
-- 2026-11-15: afterwards its schema, privileges, storage buckets and auth
-- triggers match a database built from the chain.
--
-- What it changes on production, each copied from the migration named:
--
--  1. organizations: authenticated may INSERT and UPDATE; meter_readings:
--     authenticated may INSERT, UPDATE and DELETE, as on the chain since
--     00016. Row-level security decides which rows, as everywhere else.
--  2. billing_line_items.usage_kwh is nullable (00026).
--  3. user_roles: the scope_microgrid_id projection, both scope FKs
--     DEFERRABLE, and the CHECK that pairs each role with its scope type
--     (00052). No role row uses the microgrid scope (CLAUDE.md, "Role
--     constants").
--  4. fn_change_user_role takes the scope type as a fourth argument with a
--     default, so the application's three-argument calls resolve to it, and
--     the three-argument version goes (00052). fn_list_visible_users gets the
--     chain's body; it returns the same columns.
--  5. org_api_tokens, as 00042 and 00043 define it, with 20261114222000's
--     grants. Nothing creates a token until an operator does.
--  6. organizations.customerapp_enabled, FALSE for every organization, and
--     customerapp_enabled_for_org (00044, 00047).
--  7. A user_profiles row for every auth user, and the trigger that creates
--     one for each new user (00017, 00047). Inserts one row on production
--     (2026-11-15) and changes none.
--  8. edges keeps only openems_edge_id, now NOT NULL; data_source_type,
--     openems_backend_url, their CHECK and the edge_data_source type go, and
--     fn_device_openems_component_valid stops reading them (00018, 00048).
--     The preflight below refuses when an edge would lose anything.
--  9. Function privileges: the five RLS helpers are not executable by anon
--     or PUBLIC (00047); five trigger functions lose their explicit anon and
--     authenticated grants and keep PUBLIC's, as on the chain; postgres's
--     default privileges in public stop granting EXECUTE to anon and
--     authenticated (00047).
-- 10. The invoice-logos bucket accepts 2 MB files (00035).
-- 11. household_devices.effective_from and effective_to carry the comments
--     production has, so the chain gains them too.
--
-- If a later migration redefines one of these objects, that migration is the
-- reference, not this file.

-- ── Preflight: refuse rather than drop or reject data ────────────────────
DO $$
DECLARE
  v_edges INTEGER;
  v_roles INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'edges'
       AND column_name = 'data_source_type'
  ) THEN
    EXECUTE $q$
      SELECT COUNT(*) FROM public.edges
       WHERE openems_edge_id IS NULL
          OR data_source_type::text <> 'openems'
          OR openems_backend_url IS NOT NULL
    $q$ INTO v_edges;
    IF v_edges > 0 THEN
      RAISE EXCEPTION
        'Migration refused: % edges are not plain OpenEMS edges with an openems_edge_id, or still hold an openems_backend_url. Dropping those columns would lose them.',
        v_edges;
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_roles FROM public.user_roles
   WHERE NOT COALESCE(CASE role::text
     WHEN 'super_admin'  THEN scope_type::text = 'org'
     WHEN 'org_manager'  THEN scope_type::text = 'org'       AND scope_id IS NOT NULL
     WHEN 'ems_operator' THEN scope_type::text = 'microgrid' AND scope_id IS NOT NULL
   END, FALSE);
  IF v_roles > 0 THEN
    RAISE EXCEPTION
      'Migration refused: % user_roles rows pair a role with the wrong scope type. Fix them first.',
      v_roles;
  END IF;
END $$;

-- ── 1. Table grants ──────────────────────────────────────────────────────
GRANT INSERT, UPDATE ON public.organizations TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.meter_readings TO authenticated;

-- ── 2. usage_kwh ─────────────────────────────────────────────────────────
ALTER TABLE public.billing_line_items ALTER COLUMN usage_kwh DROP NOT NULL;

-- ── 3. user_roles scope projections and pairing ──────────────────────────
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS scope_microgrid_id UUID
    GENERATED ALWAYS AS (CASE WHEN scope_type = 'microgrid' THEN scope_id END) STORED;

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_org_fkey;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_scope_org_fkey
  FOREIGN KEY (scope_org_id)
  REFERENCES public.organizations(id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_microgrid_fkey;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_scope_microgrid_fkey
  FOREIGN KEY (scope_microgrid_id)
  REFERENCES public.microgrids(id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS idx_user_roles_scope_microgrid_id
  ON public.user_roles(scope_microgrid_id);

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_scope_type_consistent;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_scope_type_consistent CHECK (
    CASE role
      WHEN 'super_admin'  THEN scope_type = 'org'
      WHEN 'org_manager'  THEN scope_type = 'org'       AND scope_id IS NOT NULL
      WHEN 'ems_operator' THEN scope_type = 'microgrid' AND scope_id IS NOT NULL
    END
  );

-- ── 4. Role and user-directory functions ─────────────────────────────────
DROP FUNCTION IF EXISTS public.fn_change_user_role(UUID, public.user_role, UUID);

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
    AND (_target_user_ids IS NULL OR au.id = ANY(_target_user_ids));
$function$;

-- ── 5. org_api_tokens ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.org_api_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_lookup  TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  env_prefix    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CHECK (token_lookup ~ '^[0-9a-f]{8}$'),
  CHECK (env_prefix ~ '^[a-z0-9_]{2,8}$')
);

COMMENT ON TABLE public.org_api_tokens IS
  'Per-org API tokens (#255). Replaces the shared INTERNAL_API_KEY model. Token plaintext is mbe_<env>_<lookup>_<secret>; we store token_lookup (non-secret, indexed) and token_hash (argon2id over the secret).';
COMMENT ON COLUMN public.org_api_tokens.name IS
  'Operator-chosen label, surfaced in audit log as actor_ref.';
COMMENT ON COLUMN public.org_api_tokens.token_lookup IS
  '8 hex chars; non-secret; indexed. Server resolves the row by this prefix, then argon2-verifies the secret remainder against token_hash.';
COMMENT ON COLUMN public.org_api_tokens.token_hash IS
  'argon2id encoded hash (~95 chars) of the secret remainder. Verified per-request; never logged or returned.';
COMMENT ON COLUMN public.org_api_tokens.env_prefix IS
  'Env marker (e.g. ''prod'', ''stag'', ''dev_''). Captured at creation time so logs can identify which env a token belongs to without inspecting the plaintext.';
COMMENT ON COLUMN public.org_api_tokens.revoked_at IS
  'Set immediately on revoke/regenerate (#256 UI). Hard cutover — no grace window. Old tokens 401 on next request.';

CREATE UNIQUE INDEX IF NOT EXISTS org_api_tokens_lookup_active_uq
  ON public.org_api_tokens(token_lookup)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS org_api_tokens_org_active_idx
  ON public.org_api_tokens(org_id, created_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.org_api_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_api_tokens_select ON public.org_api_tokens;
DROP POLICY IF EXISTS org_api_tokens_insert ON public.org_api_tokens;
DROP POLICY IF EXISTS org_api_tokens_update ON public.org_api_tokens;
CREATE POLICY org_api_tokens_select ON public.org_api_tokens FOR SELECT
  USING (is_super_admin() OR user_can_access_org(org_id));
CREATE POLICY org_api_tokens_insert ON public.org_api_tokens FOR INSERT
  WITH CHECK (is_super_admin() OR user_can_access_org(org_id));
CREATE POLICY org_api_tokens_update ON public.org_api_tokens FOR UPDATE
  USING (is_super_admin() OR user_can_access_org(org_id))
  WITH CHECK (is_super_admin() OR user_can_access_org(org_id));

REVOKE ALL ON public.org_api_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.org_api_tokens TO authenticated;
GRANT ALL ON public.org_api_tokens TO service_role;

-- ── 6. Customer app opt-in ───────────────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS customerapp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.organizations.customerapp_enabled IS
  'Per-org opt-in for the customerapp /api/v1/* integration (#251). FALSE by default — must be flipped TRUE by a super_admin (via SQL or future MBE UI) at activation time. Acts as the per-org kill switch independent of the per-org token (#255).';

CREATE OR REPLACE FUNCTION public.customerapp_enabled_for_org(_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT customerapp_enabled FROM organizations WHERE id = _org_id;
$$;

COMMENT ON FUNCTION public.customerapp_enabled_for_org(UUID) IS
  '#251 — returns organizations.customerapp_enabled for the given org_id, or NULL if the org does not exist. Called from resolveOrgFromToken (src/lib/internal-auth.ts) after token validation to enforce the per-org acceptance gate. SECURITY DEFINER so the service-role auth path can resolve it without depending on the caller`s RLS context.';

REVOKE EXECUTE ON FUNCTION public.customerapp_enabled_for_org(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customerapp_enabled_for_org(UUID) TO authenticated, service_role;

-- ── 7. A profile for every user ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_create_profile_on_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_create_profile_on_auth_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_profile_on_auth_user() TO service_role;

DROP TRIGGER IF EXISTS trg_create_profile_on_auth_user ON auth.users;
CREATE TRIGGER trg_create_profile_on_auth_user
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_create_profile_on_auth_user();

INSERT INTO public.user_profiles (user_id)
  SELECT id FROM auth.users
  ON CONFLICT (user_id) DO NOTHING;

-- ── 8. Edges are OpenEMS edges ───────────────────────────────────────────
-- The device trigger's function reads edge_data_source, so it is replaced
-- before the type goes.
CREATE OR REPLACE FUNCTION public.fn_device_openems_component_valid()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.openems_component_id IS NULL THEN
    RAISE EXCEPTION 'devices.openems_component_id is required (edge_id=%)', NEW.edge_id;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER TABLE public.edges DROP CONSTRAINT IF EXISTS edges_openems_fields_required;
ALTER TABLE public.edges DROP COLUMN IF EXISTS data_source_type;
ALTER TABLE public.edges DROP COLUMN IF EXISTS openems_backend_url;
DROP TYPE IF EXISTS public.edge_data_source;
ALTER TABLE public.edges ALTER COLUMN openems_edge_id SET NOT NULL;

-- ── 9. Function privileges ───────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_can_access_org(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_can_access_community(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_can_access_microgrid(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.user_can_see_user_profile(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_access_org(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_access_community(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_access_microgrid(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.user_can_see_user_profile(UUID) TO authenticated, service_role;

-- Trigger functions: PUBLIC keeps EXECUTE, as on the chain; only the
-- explicit grants production has on top of it go.
REVOKE EXECUTE ON FUNCTION public.fn_billing_period_stamp_timezone() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_guard_period_tariff() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_guard_referenced_tariff() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_household_device_no_overlap() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_mgm_require_community_plugin_enabled() FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- ── 10. Invoice logo size ────────────────────────────────────────────────
UPDATE storage.buckets
   SET file_size_limit = 2097152
 WHERE id = 'invoice-logos'
   AND file_size_limit IS DISTINCT FROM 2097152;

-- ── 11. Comments production already has ──────────────────────────────────
COMMENT ON COLUMN public.household_devices.effective_from IS
  'Inclusive start date for this household-device assignment.';
COMMENT ON COLUMN public.household_devices.effective_to IS
  'Exclusive end date; NULL means the assignment is current.';

NOTIFY pgrst, 'reload schema';
