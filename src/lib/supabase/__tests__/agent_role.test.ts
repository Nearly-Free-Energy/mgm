/**
 * agent_role.test.ts — #274, ADR-008 decisions 7 and 8, ADR-007 decision 1;
 * migration 20261126160000 (mgm_agent, the role an agent client's token
 * runs as).
 *
 * 1. The guard: what mgm_agent may do, read from the catalogs (pg_class,
 *    pg_attribute, pg_proc, pg_namespace, pg_auth_members, pg_policy,
 *    pg_depend and pg_publication_tables, through aclexplode and the
 *    has_*_privilege functions), not from
 *    information_schema.column_privileges, which also lists every column of
 *    a table granted whole. The lists below are the role's whole reach. A
 *    pull request that grants the role anything moves them in the same
 *    commit (CLAUDE.md, "The assistant's role").
 * 2. As an agent token through the database API: the caller's own role
 *    rows, the plugin gate, and a refusal of every write, of every table
 *    not granted and of every definer function not listed.
 *
 * The hook that gives an agent client's token this role is tested in
 * auth_access_token_hook_clients.test.ts, end to end included.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertEnvironmentReady,
  cleanupTestData,
  clientAs,
  createTestUser,
  mintAgentJwt,
  runAsDatabaseOwner,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const ROLE = "mgm_agent";

// ── The role's reach ───────────────────────────────────────────────────────
//
// Every grant to mgm_agent is listed here. A migration that grants it more
// adds the grant to these lists in the same commit, with a test that loads
// the view needing it with an agent token (ADR-008 decision 7).

/** Table privileges granted to mgm_agent itself, in any schema. */
const TABLE_GRANTS = [{ relation: "public.user_roles", privilege: "SELECT" }];

/** Column privileges granted to mgm_agent itself, in any schema. */
const COLUMN_GRANTS: { relation: string; column: string; privilege: string }[] = [];

/**
 * The definer functions in public that mgm_agent may run, through any grant.
 * is_super_admin: the super-admin policy on user_roles calls it as the
 * caller. mgm_plugin_enabled_for_org: the plugin gate and the composers.
 */
const DEFINER_FUNCTIONS = ["public.is_super_admin()", "public.mgm_plugin_enabled_for_org(uuid, text)"];

/** The policies that name mgm_agent. */
const POLICIES = [
  {
    table: "user_roles",
    name: "Agent tokens read only the caller's own role rows",
    permissive: "RESTRICTIVE",
    cmd: "ALL",
    qual: "(user_id = auth.uid())",
    with_check: "(user_id = auth.uid())",
  },
];

/**
 * The schemas the role may use, through any grant. pg_catalog and
 * information_schema are every role's; net is pg_net's, which the extension
 * opens to PUBLIC (PUBLIC_WRITES). auth is not on the list: a policy may
 * call auth.uid(), since a stored expression looks up no names, but an
 * invoker function whose body names auth.* fails for the role unless a
 * migration grants it USAGE on auth.
 */
const USABLE_SCHEMAS = ["information_schema", "net", "pg_catalog", "public"];

/**
 * What the role may write in those schemas, all of it through PUBLIC: what
 * pg_net grants PUBLIC on its queue and responses, and pg_settings, which
 * Postgres opens to every role (it is SET). anon and authenticated hold the
 * same. The database API serves public and graphql_public only
 * (supabase/config.toml, [api] schemas), so no token reaches net; if it
 * ever serves net, or a function in public the role may run reads or
 * writes it, revisit.
 */
const PUBLIC_WRITES: Record<string, string[]> = {
  "net._http_response": ["DELETE", "INSERT", "REFERENCES", "TRIGGER", "TRUNCATE", "UPDATE"],
  "net.http_request_queue": ["DELETE", "INSERT", "REFERENCES", "TRIGGER", "TRUNCATE", "UPDATE"],
  "net.http_request_queue_id_seq": ["sequence SELECT", "sequence UPDATE", "sequence USAGE"],
  "pg_catalog.pg_settings": ["UPDATE"],
};

/** Schemas Supabase serves that the role must not reach (#268). */
const CLOSED_SCHEMAS = ["storage", "graphql_public", "realtime"];

/**
 * user_roles' columns. The role reads the table whole, which is safe only
 * while no column names a person other than the row's own user_id
 * (20261126160000). A new column fails this until someone decides whether
 * an assistant may read it; if it names another person, or holds anything
 * else outside ADR-007 decision 6, grant the table by column instead.
 */
const USER_ROLES_COLUMNS = [
  "id",
  "user_id",
  "role",
  "scope_type",
  "scope_id",
  "created_at",
  "scope_org_id",
  "scope_microgrid_id",
  "scope_tenant_id",
];

/**
 * Tables whose first grant to the role brings RESTRICTIVE policies TO
 * mgm_agent with it (ADR-008 decision 8): without them the staff policies,
 * which name no role, would show a staff member's assistant every tenant of
 * the organization.
 */
const RESTRICTED_ON_FIRST_GRANT = ["public.tenants", "public.tenant_devices"];

// ── Helpers ────────────────────────────────────────────────────────────────

function ownerRows<T>(sql: string): T[] {
  const result = runAsDatabaseOwner(sql);
  expect(result.ok, result.output).toBe(true);
  return JSON.parse(result.stdout) as T[];
}

/** A relation's or a function's name, schema-qualified whatever the search path. */
const RELATION = (c: string) => `${c}.relnamespace::regnamespace::text || '.' || ${c}.relname`;
const FUNCTION = (p: string) =>
  `${p}.pronamespace::regnamespace::text || '.' || ${p}.proname || '(' || oidvectortypes(${p}.proargtypes) || ')'`;

const PUBLIC_RELATIONS = `
  SELECT c.oid, c.relname, c.relkind
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`;

/** A PostgREST refusal of a privilege: 42501, or a function left out of the schema cache. */
function expectRefused(error: { code?: string; message?: string } | null, what: string) {
  expect(error, what).not.toBeNull();
  const refused =
    error!.code === "42501" ||
    error!.message?.toLowerCase().includes("permission denied") ||
    error!.code === "PGRST202";
  expect(refused, `${what}: ${JSON.stringify(error)}`).toBe(true);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const EMAILS = {
  superAdmin: `agent-role-super-${RUN}@test.local`,
  manager: `agent-role-manager-${RUN}@test.local`,
  otherManager: `agent-role-other-${RUN}@test.local`,
};
const ORG = randomUUID();
const OTHER_ORG = randomUUID();

let superAdmin: TestUser;
let manager: TestUser;
let otherManager: TestUser;

describe.skipIf(skip)("mgm_agent, the assistant's database role (#274)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await assertEnvironmentReady();
    const svc = await serviceClient();
    for (const [id, name] of [
      [ORG, "Agent role org"],
      [OTHER_ORG, "Agent role other org"],
    ]) {
      const { error } = await svc.from("organizations").insert({ id, name });
      expect(error).toBeNull();
    }
    // Billing turned off for ORG; every other plugin answers its default.
    const { error: pluginError } = await svc
      .from("mgm_plugins")
      .insert({ org_id: ORG, plugin_name: "billing", version: "1", enabled: false });
    expect(pluginError).toBeNull();

    superAdmin = await createTestUser({ email: EMAILS.superAdmin, role: "super_admin" });
    manager = await createTestUser({
      email: EMAILS.manager,
      role: "org_manager",
      scopeId: ORG,
      extraRoles: [{ role: "org_manager", scopeType: "org", scopeId: OTHER_ORG }],
    });
    otherManager = await createTestUser({ email: EMAILS.otherManager, role: "org_manager", scopeId: OTHER_ORG });
  }, 60_000);

  afterAll(async () => {
    await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: Object.values(EMAILS) });
  }, 60_000);

  // ── 1. The guard ─────────────────────────────────────────────────────────

  describe("the role's grants, from the catalogs", () => {
    it("is NOLOGIN and holds no attribute beyond a plain role", () => {
      const [role] = ownerRows<Record<string, boolean>>(
        `SELECT rolcanlogin, rolinherit, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = '${ROLE}'`
      );
      expect(role).toEqual({
        rolcanlogin: false,
        rolinherit: false,
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
      });
    });

    it("is a member of no role, and only authenticator may switch to it", () => {
      const memberOf = ownerRows<{ role: string }>(
        `SELECT pg_get_userbyid(roleid) AS role FROM pg_auth_members WHERE member = '${ROLE}'::regrole`
      );
      expect(memberOf).toEqual([]);

      // The role that created it holds ADMIN OPTION on it, with neither SET
      // nor INHERIT, as Postgres 16 and later give a role's creator; that
      // lets it grant the role, not use it.
      const members = ownerRows<{ member: string; admin: boolean; inherit: boolean; set: boolean }>(
        `SELECT pg_get_userbyid(member) AS member, admin_option AS admin,
                inherit_option AS inherit, set_option AS set
           FROM pg_auth_members WHERE roleid = '${ROLE}'::regrole ORDER BY 1`
      );
      expect(members.filter((m) => m.set || m.inherit)).toEqual([
        { member: "authenticator", admin: false, inherit: false, set: true },
      ]);
      for (const m of members.filter((m) => !m.set && !m.inherit)) {
        expect(m.member, "only the role's creator may hold ADMIN OPTION alone").toBe("postgres");
      }

      const [reach] = ownerRows<Record<string, boolean>>(
        `SELECT pg_has_role('authenticated', '${ROLE}', 'MEMBER') AS authenticated_is_agent,
                pg_has_role('${ROLE}', 'authenticated', 'MEMBER') AS agent_is_authenticated,
                pg_has_role('${ROLE}', 'service_role', 'MEMBER') AS agent_is_service_role,
                pg_has_role('${ROLE}', 'anon', 'MEMBER') AS agent_is_anon`
      );
      expect(reach).toEqual({
        authenticated_is_agent: false,
        agent_is_authenticated: false,
        agent_is_service_role: false,
        agent_is_anon: false,
      });
    });

    it("holds exactly the listed table and column grants, in every schema", () => {
      const tables = ownerRows<{ relation: string; privilege: string }>(
        `SELECT ${RELATION("c")} AS relation, a.privilege_type AS privilege
           FROM pg_class c, aclexplode(c.relacl) a
          WHERE a.grantee = '${ROLE}'::regrole
          ORDER BY 1, 2`
      );
      expect(tables).toEqual(TABLE_GRANTS);

      const columns = ownerRows<{ relation: string; column: string; privilege: string }>(
        `SELECT ${RELATION("c")} AS relation, at.attname AS column, a.privilege_type AS privilege
           FROM pg_attribute at
           JOIN pg_class c ON c.oid = at.attrelid,
                aclexplode(at.attacl) a
          WHERE a.grantee = '${ROLE}'::regrole
          ORDER BY 1, 2, 3`
      );
      expect(columns).toEqual(COLUMN_GRANTS);
    });

    it("may use exactly the listed schemas", () => {
      const usable = ownerRows<{ schema: string }>(
        `SELECT nspname AS schema FROM pg_namespace
          WHERE has_schema_privilege('${ROLE}', oid, 'USAGE')`
      );
      expect(usable.map((r) => r.schema).sort()).toEqual([...USABLE_SCHEMAS].sort());
    });

    it("may write nothing in the schemas it may use but what PUBLIC holds, and read only the listed tables in public", () => {
      const writable = ownerRows<{ relation: string; privilege: string }>(
        `WITH rel AS (
           SELECT c.oid, ${RELATION("c")} AS relation, c.relkind
             FROM pg_class c
            WHERE has_schema_privilege('${ROLE}', c.relnamespace, 'USAGE')
              AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         )
         SELECT relation, p AS privilege
           FROM rel, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
          WHERE relkind <> 'S' AND has_table_privilege('${ROLE}', oid, p)
         UNION ALL
         SELECT relation, 'column ' || p
           FROM rel, unnest(ARRAY['INSERT', 'UPDATE', 'REFERENCES']) p
          WHERE relkind <> 'S' AND NOT has_table_privilege('${ROLE}', oid, p)
            AND has_any_column_privilege('${ROLE}', oid, p)
         UNION ALL
         SELECT relation, 'sequence ' || p
           FROM rel, unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) p
          WHERE relkind = 'S' AND has_sequence_privilege('${ROLE}', oid, p)`
      );
      const byRelation: Record<string, string[]> = {};
      for (const { relation, privilege } of writable) (byRelation[relation] ??= []).push(privilege);
      for (const privileges of Object.values(byRelation)) privileges.sort();
      expect(byRelation).toEqual(PUBLIC_WRITES);

      const readable = ownerRows<{ relation: string }>(
        `SELECT 'public.' || r.relname AS relation FROM (${PUBLIC_RELATIONS}) r
          WHERE r.relkind <> 'S' AND has_any_column_privilege('${ROLE}', r.oid, 'SELECT')
          ORDER BY 1`
      );
      expect(readable.map((r) => r.relation)).toEqual(
        [...new Set([...TABLE_GRANTS, ...COLUMN_GRANTS].map((g) => g.relation))].sort()
      );
    });

    // Postgres makes every new function executable through PUBLIC; a definer
    // function is closed to the role only by its own REVOKE … FROM PUBLIC.
    // Invoker functions run as the role, so they are not listed (ADR-008
    // decision 7).
    it("may run exactly the listed definer functions, in every schema it may use", () => {
      const runnable = ownerRows<{ fn: string }>(
        `SELECT ${FUNCTION("p")} AS fn
           FROM pg_proc p
          WHERE has_schema_privilege('${ROLE}', p.pronamespace, 'USAGE')
            AND p.prosecdef
            AND has_function_privilege('${ROLE}', p.oid, 'EXECUTE')
          ORDER BY 1`
      );
      expect(runnable.map((r) => r.fn)).toEqual([...DEFINER_FUNCTIONS].sort());

      const granted = ownerRows<{ fn: string }>(
        `SELECT ${FUNCTION("p")} AS fn
           FROM pg_proc p, aclexplode(p.proacl) a
          WHERE a.grantee = '${ROLE}'::regrole
          ORDER BY 1`
      );
      expect(granted.map((r) => r.fn)).toEqual([...DEFINER_FUNCTIONS].sort());
    });

    it("has no usage on storage, graphql_public or realtime, and no schema grant of its own", () => {
      const open = ownerRows<{ schema: string }>(
        `SELECT s AS schema FROM unnest(ARRAY[${CLOSED_SCHEMAS.map((s) => `'${s}'`).join(", ")}]) s
          WHERE has_schema_privilege('${ROLE}', s, 'USAGE') OR has_schema_privilege('${ROLE}', s, 'CREATE')`
      );
      expect(open).toEqual([]);
      const granted = ownerRows<{ schema: string }>(
        `SELECT n.nspname AS schema FROM pg_namespace n, aclexplode(n.nspacl) a
          WHERE a.grantee = '${ROLE}'::regrole`
      );
      expect(granted).toEqual([]);
      const [db] = ownerRows<{ create: boolean }>(
        `SELECT has_database_privilege('${ROLE}', current_database(), 'CREATE') AS create`
      );
      expect(db.create).toBe(false);
    });

    it("is named by exactly the listed policies, and no policy names it on any other table", () => {
      const policies = ownerRows<Record<string, string | null>>(
        `SELECT tablename AS table, policyname AS name, permissive, cmd, qual, with_check
           FROM pg_policies
          WHERE '${ROLE}' = ANY (roles)
          ORDER BY schemaname, tablename, policyname`
      );
      expect(policies).toEqual(POLICIES);
    });

    it("reads user_roles, granted whole, only while its columns are the listed ones", () => {
      const columns = ownerRows<{ column: string }>(
        `SELECT attname AS column FROM pg_attribute
          WHERE attrelid = 'public.user_roles'::regclass AND attnum > 0 AND NOT attisdropped
          ORDER BY attnum`
      );
      expect(columns.map((c) => c.column)).toEqual(USER_ROLES_COLUMNS);
    });

    it("reads tenants or tenant_devices only together with a RESTRICTIVE read policy TO mgm_agent on that table", () => {
      const unrestricted = ownerRows<{ relation: string }>(
        `SELECT t AS relation
           FROM unnest(ARRAY[${RESTRICTED_ON_FIRST_GRANT.map((t) => `'${t}'`).join(", ")}]) t
          WHERE has_any_column_privilege('${ROLE}', t::regclass, 'SELECT')
            AND NOT EXISTS (
              SELECT 1 FROM pg_policy pol
               WHERE pol.polrelid = t::regclass
                 AND NOT pol.polpermissive
                 AND '${ROLE}'::regrole = ANY (pol.polroles)
                 AND pol.polcmd IN ('r', '*'))`
      );
      expect(unrestricted).toEqual([]);
    });

    // A table in the publication sends its changes to subscribers as the
    // role their token names, under that role's grants and policies. Adding
    // one needs a decision about this role at the same time (CLAUDE.md).
    it("finds no table in the supabase_realtime publication", () => {
      const published = ownerRows<{ relation: string }>(
        `SELECT schemaname || '.' || tablename AS relation
           FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`
      );
      expect(published).toEqual([]);
    });

    // A read fails as a whole when a policy that applies to it calls a
    // function, or reads a table, the role may not (#268: a nested read
    // failed until the role could run the helper its policy called). So every
    // table the role may read is readable without error. Postgres records a
    // policy's read of another table per column (refobjsubid is the
    // column's number) and only a reference with no column on the table
    // itself, so the check follows it: a grant by column must cover each
    // column a policy reads.
    it("may run every function, and read every table, that a policy on a table it reads calls as it", () => {
      const missing = ownerRows<{ relation: string; policy: string; needs: string }>(
        `WITH readable AS (
           SELECT r.oid FROM (${PUBLIC_RELATIONS}) r
            WHERE r.relkind <> 'S' AND has_any_column_privilege('${ROLE}', r.oid, 'SELECT')
         ), applies AS (
           SELECT pol.oid, pol.polrelid, pol.polname
             FROM pg_policy pol
            WHERE pol.polrelid IN (SELECT oid FROM readable)
              AND pol.polcmd IN ('r', '*')
              AND (0::oid = ANY (pol.polroles) OR '${ROLE}'::regrole = ANY (pol.polroles))
         )
         SELECT a.polrelid::regclass::text AS relation, a.polname AS policy,
                p.oid::regprocedure::text AS needs
           FROM applies a
           JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = a.oid
                            AND d.refclassid = 'pg_proc'::regclass
           JOIN pg_proc p ON p.oid = d.refobjid
          WHERE NOT has_function_privilege('${ROLE}', p.oid, 'EXECUTE')
         UNION
         SELECT a.polrelid::regclass::text, a.polname,
                d.refobjid::regclass::text
                  || CASE WHEN d.refobjsubid = 0 THEN ''
                          ELSE '.' || (SELECT attname FROM pg_attribute
                                        WHERE attrelid = d.refobjid AND attnum = d.refobjsubid) END
           FROM applies a
           JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = a.oid
                            AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> a.polrelid
          WHERE NOT CASE WHEN d.refobjsubid = 0
                         THEN has_any_column_privilege('${ROLE}', d.refobjid, 'SELECT')
                         ELSE has_column_privilege('${ROLE}', d.refobjid, d.refobjsubid::int2, 'SELECT') END`
      );
      expect(missing).toEqual([]);
    });
  });

  // ── 2. As an agent token ─────────────────────────────────────────────────

  describe("through the database API, as an agent token", () => {
    const agentOf = async (user: TestUser) => clientAs(await mintAgentJwt(user.userId));

    it("reads the caller's own role rows, every column", async () => {
      const agent = await agentOf(manager);
      const { data, error } = await agent.from("user_roles").select("*").order("scope_id");
      expect(error).toBeNull();
      expect(data).toHaveLength(2);
      for (const row of data!) {
        expect(row.user_id).toBe(manager.userId);
        expect(row.role).toBe("org_manager");
      }
      expect(new Set(data!.map((row) => row.scope_id))).toEqual(new Set([ORG, OTHER_ORG]));
    });

    it("gives a super admin's agent token their own rows and no one else's", async () => {
      // The same person's browser token reads every role row (00002).
      const { data: everyone, error: browserError } = await superAdmin.client
        .from("user_roles")
        .select("user_id")
        .in("user_id", [superAdmin.userId, manager.userId, otherManager.userId]);
      expect(browserError).toBeNull();
      expect(new Set(everyone!.map((r) => r.user_id))).toEqual(
        new Set([superAdmin.userId, manager.userId, otherManager.userId])
      );

      const agent = await agentOf(superAdmin);
      const { data, error } = await agent.from("user_roles").select("user_id, role, scope_type, scope_id");
      expect(error).toBeNull();
      expect(data).toEqual([{ user_id: superAdmin.userId, role: "super_admin", scope_type: "org", scope_id: null }]);

      const { data: asked, error: askedError } = await agent
        .from("user_roles")
        .select("id")
        .in("user_id", [manager.userId, otherManager.userId]);
      expect(askedError).toBeNull();
      expect(asked).toEqual([]);
    });

    it("gets the plugin gate's answers, the same as the browser token", async () => {
      const agent = await agentOf(manager);
      const cases: [string, string, boolean][] = [
        [ORG, "billing", false], // its row turns it off
        [ORG, "metering", true], // no row: on by default
        [ORG, "tenant-app", false], // no row: off by default
        [OTHER_ORG, "billing", true],
      ];
      for (const [org, plugin, expected] of cases) {
        for (const db of [agent, manager.client]) {
          const { data, error } = await db.rpc("mgm_plugin_enabled_for_org", {
            _org_id: org,
            _plugin_name: plugin,
          });
          expect(error, `${plugin}`).toBeNull();
          expect(data, `${org} ${plugin}`).toBe(expected);
        }
      }
    });

    it("is refused every insert, update and delete, on every table in public", async () => {
      const tables = ownerRows<{ relation: string; column: string }>(
        `SELECT r.relname AS relation,
                (SELECT a.attname FROM pg_attribute a
                  WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
                    AND a.attidentity = '' AND a.attgenerated = ''
                  ORDER BY a.attnum LIMIT 1) AS column
           FROM (${PUBLIC_RELATIONS}) r
          WHERE r.relkind IN ('r', 'p')
          ORDER BY 1`
      );
      expect(tables.map((t) => t.relation)).toContain("user_roles");
      const agent = await agentOf(superAdmin);
      for (const { relation, column } of tables) {
        const insert = await agent.from(relation).insert({});
        expectRefused(insert.error, `insert into ${relation}`);
        const update = await agent
          .from(relation)
          .update({ [column]: null })
          .is(column, null);
        expectRefused(update.error, `update ${relation}`);
        const remove = await agent.from(relation).delete().is(column, null);
        expectRefused(remove.error, `delete from ${relation}`);
      }
      // A super admin's own role row, which the agent token reads, stays as it was.
      const { data } = await agent.from("user_roles").select("role");
      expect(data).toEqual([{ role: "super_admin" }]);
    });

    it("is refused, with 42501, a table it is not granted, where the browser token reads it", async () => {
      const agent = await agentOf(superAdmin);
      for (const table of ["organizations", "communities", "microgrids", "tenants", "devices", "mgm_plugins"]) {
        const { error } = await agent.from(table).select("id").limit(1);
        expect(error?.code, table).toBe("42501");
      }
      const { data, error } = await superAdmin.client.from("organizations").select("id").eq("id", ORG);
      expect(error).toBeNull();
      expect(data).toEqual([{ id: ORG }]);
    });

    it("is refused a definer function that is not listed", async () => {
      const agent = await agentOf(superAdmin);
      const calls: [string, Record<string, unknown>][] = [
        ["fn_list_visible_users", { _target_user_ids: null }],
        ["user_can_access_org", { _org_id: ORG }],
        ["user_can_access_microgrid", { _microgrid_id: randomUUID() }],
        ["fn_tenant_home", { _tenant_id: randomUUID() }],
        ["fn_tenant_access_list", { _tenant_id: randomUUID() }],
      ];
      for (const [fn, args] of calls) {
        const { error } = await agent.rpc(fn, args);
        expectRefused(error, fn);
      }
      // The same call with the browser token is answered.
      const { error } = await superAdmin.client.rpc("user_can_access_org", { _org_id: ORG });
      expect(error).toBeNull();
    });
  });
});
