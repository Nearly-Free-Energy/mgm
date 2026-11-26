-- RFC #259 § 2 and decision 12, ADR-008 decisions 7 and 8, ADR-007 decision
-- 1 (#274): the database role an assistant's token runs as.
--
-- An agent client (mgm_clients.kind = 'agent') is the signed-in person, but
-- its token must not carry that person's full authority at the database
-- API. The access-token hook (20261126160100) therefore gives an agent
-- client's token the role mgm_agent instead of authenticated, and PostgREST
-- switches to it as it switches to authenticated.
--
-- The role:
--   * is NOLOGIN, and granted to authenticator only, so PostgREST can switch
--     to it. It is never made a member of authenticated or of any other
--     role, so it holds only what is granted to mgm_agent itself (or to
--     PUBLIC). It is also NOINHERIT, so a membership granted to it by
--     mistake later, unless the grant says WITH INHERIT TRUE, would give it
--     no privilege and no policy written for that role unless it switched to
--     it, which nothing does. Since Postgres 16 the attribute only sets the
--     default for a grant that names no INHERIT option; what keeps the role
--     a member of nothing is the check below and the guard test. PostgREST's
--     switch uses authenticator's membership, not this attribute.
--   * reads no table and no column unless a migration grants it. This one
--     grants only what every agent call needs (ADR-008 decision 7): the
--     caller's own role rows, which the GUI host and the composers read
--     with the caller's client, the ids and names of the organizations
--     they reach, which the GUI host reads with it before it asks the
--     assistant's gate, and the plugin gate. The rows a marked view's path
--     names (communities, microgrids, edges) come with the first marked view
--     whose path names one.
--   * holds no write privilege of its own, and none in public through
--     PUBLIC. Through PUBLIC it may write only what extensions and Postgres
--     give every role (PUBLIC_WRITES in agent_role.test.ts), so an invoker
--     function it runs cannot write MGM's tables, and reads only what the
--     role's grants allow. If a function in public it may run writes one of
--     those, revisit.
--   * may run a definer function only when that function's EXECUTE is not
--     revoked from PUBLIC or is granted to mgm_agent. CLAUDE.md requires
--     every definer function to revoke EXECUTE from PUBLIC, and
--     src/lib/supabase/__tests__/agent_role.test.ts pins the definer
--     functions the role may run, its table and column grants, and its
--     schemas.
--
-- A grant to mgm_agent comes with the pull request that needs it, and that
-- test's lists move in the same commit (CLAUDE.md). The marked views of
-- ADR-007's first list add their loaders' grants and policy twins one pull
-- request at a time; the tenant data and its restrictive policies come with
-- the tenant phase (#259 D2). Nothing here edits a helper or an existing
-- policy.
--
-- Roles belong to the cluster, not to the database, so on a local database
-- reset the role may already exist. It is then made NOINHERIT, which only
-- takes away, and checked rather than created: the migration stops if the
-- role can log in, has an attribute it must not have, or is a member of any
-- role.

DO $$
DECLARE
  _problems TEXT[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mgm_agent') THEN
    CREATE ROLE mgm_agent NOLOGIN NOINHERIT;
  ELSE
    ALTER ROLE mgm_agent NOINHERIT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'mgm_agent'
       AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) THEN
    _problems := array_append(_problems, 'mgm_agent can log in or has an attribute it must not have');
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
     WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'mgm_agent')
  ) THEN
    _problems := array_append(_problems, 'mgm_agent is a member of another role');
  END IF;

  IF cardinality(_problems) > 0 THEN
    RAISE EXCEPTION 'mgm_agent already exists and is not the role this migration creates: %',
      array_to_string(_problems, '; ');
  END IF;
END;
$$;

-- PostgREST connects as authenticator and switches to the token's role.
GRANT mgm_agent TO authenticator;

-- ── The caller's own role rows ─────────────────────────────────────────────
--
-- The GUI host and the composers read the caller's role rows with the
-- caller's client. Three existing policies on user_roles name no role, so
-- they apply to mgm_agent. The two that apply to a read are "Users can view
-- their own roles" and "Super admins can manage all user_roles" (00002),
-- which calls is_super_admin() directly as the caller. The third, "Org
-- managers can delete user_roles in their orgs" (00013), is FOR DELETE, and
-- the role is never given DELETE (it may run user_can_access_org, which that
-- policy calls, for the organizations read below). Under the first two
-- alone a super admin's assistant would read every role row, so this
-- RESTRICTIVE policy limits the role to the caller's own. user_id is then
-- only ever the caller's, no other column names a person, and no loader
-- puts a row into a model, so the table is granted whole (ADR-008 decision
-- 8); agent_role.test.ts pins its columns. If user_roles gains a column
-- that names another person, or holds anything else outside ADR-007
-- decision 6, grant it by column instead. The policy is FOR ALL so it
-- bounds any privilege the role is ever given here, not only SELECT; the
-- role is given none but SELECT. It also bounds any policy added later that
-- names no role.
GRANT SELECT ON public.user_roles TO mgm_agent;

CREATE POLICY "Agent tokens read only the caller's own role rows"
  ON public.user_roles
  AS RESTRICTIVE
  FOR ALL
  TO mgm_agent
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- The super-admin policy above calls it as the caller, so a read of
-- user_roles as mgm_agent fails without it. It answers only for the caller.
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO mgm_agent;

-- ── The caller's organizations ─────────────────────────────────────────────
--
-- The GUI host reads the organizations the caller reaches, by id and name,
-- with the caller's client, before it asks the assistant's gate: the
-- catalog and every organization view choose one (visibleOrganizations in
-- src/lib/gui/host/server/organization.ts), and a view whose path names an
-- organization reads its row the same way. Ids and names of the caller's
-- organizations are inside ADR-007 decision 6; the address columns are not,
-- so the table is granted by column. Its one existing policy, "Authorized
-- users can access organizations" (00002), names no role and calls
-- user_can_access_org(id) as the caller, so the role reads exactly the
-- organizations the person reaches. user_can_access_org answers only for
-- the caller. A policy added later that names no role would apply to the
-- role too, so this RESTRICTIVE policy holds it to the same organizations
-- whatever such a policy allows, as the one on user_roles does; it is FOR
-- ALL for the same reason. If the host reads another column of
-- organizations, revisit.
GRANT SELECT (id, name) ON public.organizations TO mgm_agent;
GRANT EXECUTE ON FUNCTION public.user_can_access_org(UUID) TO mgm_agent;

CREATE POLICY "Agent tokens read only the caller's organizations"
  ON public.organizations
  AS RESTRICTIVE
  FOR ALL
  TO mgm_agent
  USING (user_can_access_org(id))
  WITH CHECK (user_can_access_org(id));

-- ── The plugin gate ────────────────────────────────────────────────────────
--
-- The gate and the composers ask it with the caller's client. It answers one
-- organization's plugin on/off state for an id the caller already has
-- (20261125120000).
GRANT EXECUTE ON FUNCTION public.mgm_plugin_enabled_for_org(UUID, TEXT) TO mgm_agent;
