/**
 * operation_records.test.ts (migration 20261126120000)
 *
 * The operations plugin's records (#133 A2-8; docs/investigation-evidence.md
 * § 3 and § 10), against a live local Supabase:
 *   - definitions and privileges: row security on, one FOR SELECT policy per
 *     table through user_can_access_microgrid, SELECT the only privilege of
 *     authenticated and service_role, nothing for anon; the write functions
 *     are SECURITY DEFINER, owned by postgres, with a pinned search_path and
 *     EXECUTE for authenticated alone (E8); the guard triggers; no realtime;
 *     the column and argument pins;
 *   - direct writes refused for a manager, the service role and anon (E1);
 *   - fn_operation_create: access, plugin, zone and date checks (O1, O2);
 *   - fn_operation_transition: cancel and access_refused only, access, plugin
 *     and state checks, and the lock against a concurrent change (O3, O4,
 *     E3);
 *   - the guard triggers, as the owner, since no API role can write (O1, O4,
 *     E2, E3, E5);
 *   - deleting a user nulls their references; deleting a microgrid or an
 *     organization removes its operations and evidence (§ 9).
 *
 * Evidence rows are written as the database owner: A2-8 has no capture
 * function (A2-9 adds it).
 *
 * Self-fixturing; honors `SKIP_RLS_TESTS=1` for runs without local Supabase.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { addDaysToDateKey, dayKeyInZone } from "@/lib/timezone/day-key";
import type { Operation } from "@/lib/types/domain";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  createTestUser,
  runAsDatabaseOwner,
  raceAgainstHeldTransaction,
  clientAs,
  LOCAL_SUPABASE_URL,
  testAnonKey,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[operation_records] SKIP_RLS_TESTS=1 — skipping suite.");
}

const F = {
  orgA: "0b5e0000-0000-4000-8000-00000000000a",
  orgB: "0b5e0000-0000-4000-8000-00000000000b",
  orgC: "0b5e0000-0000-4000-8000-00000000000c",
  communityA: "0b5e0000-0000-4000-8001-00000000000a",
  communityB: "0b5e0000-0000-4000-8001-00000000000b",
  communityC: "0b5e0000-0000-4000-8001-00000000000c",
  mgA: "0b5e0000-0000-4000-8002-000000000001",
  mgAKiritimati: "0b5e0000-0000-4000-8002-000000000002",
  mgAPagoPago: "0b5e0000-0000-4000-8002-000000000003",
  mgABadZone: "0b5e0000-0000-4000-8002-000000000004",
  mgAUtc: "0b5e0000-0000-4000-8002-000000000005",
  mgACascade: "0b5e0000-0000-4000-8002-000000000006",
  mgB: "0b5e0000-0000-4000-8002-000000000007",
  mgC: "0b5e0000-0000-4000-8002-000000000008",
  mgAOffset: "0b5e0000-0000-4000-8002-000000000009",
  mgAAbbrev: "0b5e0000-0000-4000-8002-00000000000a",
  tenantA: "0b5e0000-0000-4000-8005-00000000000a",
};

const ZONE = {
  mgA: "Africa/Kampala",
  mgAKiritimati: "Pacific/Kiritimati",
  mgAPagoPago: "Pacific/Pago_Pago",
  mgABadZone: "Not/AZone",
  mgAUtc: "UTC",
  // Zones Postgres knows and validateTimezone refuses by shape, so
  // openSiteQuery replaces them with the UTC fallback.
  mgAOffset: "UTC+3",
  mgAAbbrev: "EST",
} as const;

const STAMP = Date.now();
const EMAIL = {
  managerA: `opsrec-mgr-a-${STAMP}@test.local`,
  managerB: `opsrec-mgr-b-${STAMP}@test.local`,
  superAdmin: `opsrec-sa-${STAMP}@test.local`,
  tenant: `opsrec-tenant-${STAMP}@test.local`,
  noRole: `opsrec-norole-${STAMP}@test.local`,
  deletable: `opsrec-deletable-${STAMP}@test.local`,
};

let managerA: TestUser;
let managerB: TestUser;
let superAdmin: TestUser;
let tenantUser: TestUser;
let noRole: TestUser;

// ── Helpers ─────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownerRows<T>(sql: string): T[] {
  const result = runAsDatabaseOwner(sql);
  if (!result.ok) throw new Error(`[operation_records] owner query failed: ${result.output}`);
  return JSON.parse(result.stdout) as T[];
}

interface OwnerAttempt {
  ok: boolean;
  sqlstate: string | null;
  detail: string | null;
  message: string | null;
}

/**
 * Runs one statement as the owner and reports how it ended. The CLI prints
 * only an error's message, so the statement runs in a DO block that catches
 * the error and raises one whose message carries its SQLSTATE and DETAIL.
 */
function ownerAttempt(statement: string): OwnerAttempt {
  const result = runAsDatabaseOwner(
    [
      "DO $attempt$",
      "DECLARE v_state text; v_detail text; v_message text;",
      "BEGIN",
      `  ${statement};`,
      "EXCEPTION WHEN OTHERS THEN",
      "  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL, v_message = MESSAGE_TEXT;",
      "  RAISE EXCEPTION 'ATTEMPT|%|%|%', v_state, coalesce(v_detail, ''), v_message;",
      "END",
      "$attempt$",
    ].join("\n"),
  );
  if (result.ok) return { ok: true, sqlstate: null, detail: null, message: null };
  const match = /ATTEMPT\|([0-9A-Z]{5})\|([^|]*)\|([^\n]*)/.exec(result.output);
  if (!match) throw new Error(`[operation_records] owner statement failed unexpectedly: ${result.output}`);
  return { ok: false, sqlstate: match[1], detail: match[2] || null, message: match[3] };
}

async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) throw new Error(`[operation_records] fixture insert failed on ${table}: ${error.message}`);
}

/** Sets the operations plugin's row for an organization; null removes it. */
async function setPlugin(orgId: string, enabled: boolean | null): Promise<void> {
  const svc = await serviceClient();
  if (enabled === null) {
    const { error } = await svc.from("mgm_plugins").delete().eq("org_id", orgId).eq("plugin_name", "operations");
    if (error) throw new Error(`[operation_records] mgm_plugins: ${error.message}`);
    return;
  }
  const { error } = await svc
    .from("mgm_plugins")
    .upsert({ org_id: orgId, plugin_name: "operations", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[operation_records] mgm_plugins: ${error.message}`);
}

function todayIn(tz: string): string {
  return dayKeyInZone(Date.now(), tz);
}

function yesterdayIn(tz: string): string {
  return addDaysToDateKey(todayIn(tz), -1);
}

/**
 * Runs `fn` with today's date in `tz`, again if the date turned while it ran,
 * whether the first run passed or failed: a turn makes its assertions wrong.
 */
async function withTodayIn<T>(tz: string, fn: (today: string) => Promise<T>): Promise<T> {
  const before = todayIn(tz);
  try {
    const result = await fn(before);
    if (todayIn(tz) === before) return result;
  } catch (error) {
    if (todayIn(tz) === before) throw error;
  }
  return fn(todayIn(tz));
}

interface CreateArgs {
  _microgrid_id: string | null;
  _window_date: string | null;
  _window_tz: string | null;
  _window_zone: "microgrid" | "fallback" | null;
}

function create(who: SupabaseClient, args: CreateArgs) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return who.rpc("fn_operation_create", args as any);
}

/** Creates a running operation on mgA for yesterday in Kampala, or throws. */
async function createOnA(who: TestUser = managerA, microgridId: string = F.mgA): Promise<Operation> {
  const { data, error } = await create(who.client, {
    _microgrid_id: microgridId,
    _window_date: yesterdayIn(ZONE.mgA),
    _window_tz: ZONE.mgA,
    _window_zone: "microgrid",
  });
  if (error || !data) throw new Error(`[operation_records] create failed: ${error?.message}`);
  return data as Operation;
}

function transition(who: SupabaseClient, operationId: string | null, to: string | null, failureCode: string | null = null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return who.rpc("fn_operation_transition", { _operation_id: operationId, _to: to, _failure_code: failureCode } as any);
}

/** Reads an operation as the owner, past row security. */
function operationRow(id: string): Operation | undefined {
  if (!UUID_RE.test(id)) throw new Error(`not a uuid: ${id}`);
  return ownerRows<Operation>(`SELECT * FROM public.operations WHERE id = '${id}'`)[0];
}

function countOperations(where: string): number {
  return ownerRows<{ n: number }>(`SELECT count(*)::int AS n FROM public.operations WHERE ${where}`)[0].n;
}

function countEvidence(where: string): number {
  return ownerRows<{ n: number }>(`SELECT count(*)::int AS n FROM public.operation_evidence WHERE ${where}`)[0].n;
}

/** An owner INSERT of one evidence row, with the operation's ids unless overridden. */
function evidenceInsert(
  op: Pick<Operation, "id" | "microgrid_id" | "org_id">,
  opts: {
    outcome?: "read" | "refused";
    attemptKey?: string;
    capturedBy?: string | null;
    microgridId?: string;
    orgId?: string;
  } = {},
): string {
  const capturedBy = opts.capturedBy ? `'${opts.capturedBy}'` : "NULL";
  return `INSERT INTO public.operation_evidence
            (operation_id, microgrid_id, org_id, attempt_key, schema_name, outcome, content, size, captured_by)
          VALUES ('${op.id}', '${opts.microgridId ?? op.microgrid_id}', '${opts.orgId ?? op.org_id}',
                  '${opts.attemptKey ?? randomUUID()}', 'site-day-evidence/1', '${opts.outcome ?? "refused"}',
                  '{"synthetic": true}'::jsonb, 19, ${capturedBy})`;
}

function insertEvidenceOrThrow(op: Pick<Operation, "id" | "microgrid_id" | "org_id">, opts: Parameters<typeof evidenceInsert>[1] = {}): void {
  const attempt = ownerAttempt(evidenceInsert(op, opts));
  if (!attempt.ok) throw new Error(`[operation_records] evidence insert failed: ${attempt.sqlstate} ${attempt.message}`);
}

function expectRefusal(
  error: { code?: string; details?: string; message?: string } | null,
  sqlstate: string,
  code: string,
): void {
  expect(error, `expected ${code}`).not.toBeNull();
  expect(error?.code).toBe(sqlstate);
  expect(error?.details).toBe(code);
  expect(error?.message).toMatch(new RegExp(`^${code}:`));
}

function expectOwnerRefusal(attempt: OwnerAttempt, sqlstate: string, code?: string): void {
  expect(attempt.ok, `expected ${code ?? sqlstate}`).toBe(false);
  expect(attempt.sqlstate).toBe(sqlstate);
  if (code) expect(attempt.detail).toBe(code);
}

function expectApiRoleRefused(error: { code?: string; message?: string } | null): void {
  expect(error).not.toBeNull();
  expect(
    error?.code === "42501" ||
      error?.message?.toLowerCase().includes("permission denied") ||
      error?.code === "PGRST202",
  ).toBe(true);
}

/** A signed-in role with no user: role 'authenticated' and no sub claim. */
async function noSubjectClient(): Promise<SupabaseClient> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    aud: "authenticated",
    role: "authenticated",
    iss: `${LOCAL_SUPABASE_URL}/auth/v1`,
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!));
  return clientAs(jwt);
}

function expectCheckViolation(attempt: OwnerAttempt, constraint: string): void {
  expect(attempt.ok, `expected ${constraint}`).toBe(false);
  expect(attempt.sqlstate, constraint).toBe("23514");
  expect(attempt.message, constraint).toContain(`"${constraint}"`);
}

function anonClient(): SupabaseClient {
  return createClient(LOCAL_SUPABASE_URL, testAnonKey()!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function cleanupFixtures(): Promise<void> {
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_plugins").delete().in("org_id", [F.orgA, F.orgB, F.orgC]);
  if (error) throw new Error(`[operation_records] cleanup failed: ${error.message}`);
  await cleanupTestData({ orgIds: [F.orgA, F.orgB, F.orgC], userEmails: Object.values(EMAIL) });
}

const OPERATION_COLUMNS = [
  "id",
  "microgrid_id",
  "org_id",
  "window_date",
  "window_tz",
  "window_zone",
  "status",
  "failure_code",
  "result",
  "result_size",
  "created_by",
  "created_at",
  "ended_by",
  "ended_at",
];

const EVIDENCE_COLUMNS = [
  "id",
  "operation_id",
  "microgrid_id",
  "org_id",
  "attempt_key",
  "schema_name",
  "outcome",
  "content",
  "size",
  "captured_by",
  "captured_at",
];

// Owner queries go through the supabase CLI, about a second each, so the
// guard tests take longer than the default five seconds.
desc("20261126120000_operation_records.sql", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();
    await cleanupFixtures();

    await insertOrThrow(svc, "organizations", [
      { id: F.orgA, name: "Operation Records Org A" },
      { id: F.orgB, name: "Operation Records Org B" },
      { id: F.orgC, name: "Operation Records Org C" },
    ]);
    await insertOrThrow(svc, "communities", [
      { id: F.communityA, org_id: F.orgA, name: "OR Comm A" },
      { id: F.communityB, org_id: F.orgB, name: "OR Comm B" },
      { id: F.communityC, org_id: F.orgC, name: "OR Comm C" },
    ]);
    await insertOrThrow(svc, "microgrids", [
      { id: F.mgA, community_id: F.communityA, name: "OR MG A", currency: "UGX", timezone: ZONE.mgA },
      { id: F.mgAKiritimati, community_id: F.communityA, name: "OR MG Kiritimati", currency: "UGX", timezone: ZONE.mgAKiritimati },
      { id: F.mgAPagoPago, community_id: F.communityA, name: "OR MG Pago Pago", currency: "UGX", timezone: ZONE.mgAPagoPago },
      { id: F.mgABadZone, community_id: F.communityA, name: "OR MG bad zone", currency: "UGX", timezone: ZONE.mgABadZone },
      { id: F.mgAUtc, community_id: F.communityA, name: "OR MG UTC", currency: "UGX", timezone: ZONE.mgAUtc },
      { id: F.mgACascade, community_id: F.communityA, name: "OR MG cascade", currency: "UGX", timezone: ZONE.mgA },
      { id: F.mgB, community_id: F.communityB, name: "OR MG B", currency: "UGX", timezone: ZONE.mgA },
      { id: F.mgC, community_id: F.communityC, name: "OR MG C", currency: "UGX", timezone: ZONE.mgA },
      { id: F.mgAOffset, community_id: F.communityA, name: "OR MG offset zone", currency: "UGX", timezone: ZONE.mgAOffset },
      { id: F.mgAAbbrev, community_id: F.communityA, name: "OR MG abbreviated zone", currency: "UGX", timezone: ZONE.mgAAbbrev },
    ]);
    await insertOrThrow(svc, "tenants", {
      id: F.tenantA,
      microgrid_id: F.mgA,
      display_name: "OR Tenant",
      primary_phone: "+256700000021",
    });

    managerA = await createTestUser({ email: EMAIL.managerA, role: "org_manager", scopeId: F.orgA });
    managerB = await createTestUser({ email: EMAIL.managerB, role: "org_manager", scopeId: F.orgB });
    superAdmin = await createTestUser({ email: EMAIL.superAdmin, role: "super_admin" });
    tenantUser = await createTestUser({ email: EMAIL.tenant, role: "tenant", scopeId: F.tenantA });
    noRole = await createTestUser({ email: EMAIL.noRole, role: null });

    await setPlugin(F.orgA, true);
    await setPlugin(F.orgB, true);
    await setPlugin(F.orgC, true);
  }, 120_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupFixtures();
  }, 60_000);

  // ── Definitions and privileges (E1, E8, § 10) ──────────────────────────

  it("both tables have row security on, not forced", () => {
    const rows = ownerRows<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced
         FROM pg_class
        WHERE oid IN ('public.operations'::regclass, 'public.operation_evidence'::regclass)
        ORDER BY relname`,
    );
    expect(rows).toEqual([
      { relname: "operation_evidence", rls: true, forced: false },
      { relname: "operations", rls: true, forced: false },
    ]);
  });

  it("each table has exactly one policy: FOR SELECT to authenticated through user_can_access_microgrid", () => {
    const rows = ownerRows<{ tablename: string; cmd: string; roles: string; permissive: string; qual: string; with_check: string | null }>(
      `SELECT tablename, cmd, roles::text AS roles, permissive, qual, with_check
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename IN ('operations', 'operation_evidence')
        ORDER BY tablename`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tablename)).toEqual(["operation_evidence", "operations"]);
    for (const row of rows) {
      expect(row).toMatchObject({ cmd: "SELECT", roles: "{authenticated}", permissive: "PERMISSIVE", with_check: null });
      expect(row.qual).toBe("user_can_access_microgrid(microgrid_id)");
    }
  });

  it("authenticated and service_role hold SELECT alone, anon nothing", () => {
    const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
    const rows = ownerRows<{ role: string; tbl: string; privilege: string; held: boolean }>(
      `SELECT r AS role, t AS tbl, p AS privilege, has_table_privilege(r, t, p) AS held
         FROM unnest(ARRAY['authenticated', 'service_role', 'anon']) AS r,
              unnest(ARRAY['public.operations', 'public.operation_evidence']) AS t,
              unnest(ARRAY[${privileges.map((p) => `'${p}'`).join(", ")}]) AS p`,
    );
    expect(rows).toHaveLength(3 * 2 * privileges.length);
    for (const row of rows) {
      const expected = row.privilege === "SELECT" && row.role !== "anon";
      expect(row.held, `${row.role} ${row.privilege} on ${row.tbl}`).toBe(expected);
    }
    // No column-level grant reopens a write either.
    const columns = ownerRows<{ any: boolean }>(
      `SELECT bool_or(has_any_column_privilege(r, t, 'INSERT, UPDATE, REFERENCES')) AS any
         FROM unnest(ARRAY['authenticated', 'service_role', 'anon']) AS r,
              unnest(ARRAY['public.operations', 'public.operation_evidence']) AS t`,
    );
    expect(columns).toEqual([{ any: false }]);
  });

  it("the write functions are SECURITY DEFINER, owned by postgres, pinned, and executable by authenticated alone", () => {
    const rows = ownerRows<{
      fn: string;
      definer: boolean;
      owner: string;
      config: string;
      authenticated: boolean;
      anon: boolean;
      service_role: boolean;
      public_grants: number;
    }>(
      `SELECT p.oid::regprocedure::text AS fn,
              p.prosecdef AS definer,
              pg_get_userbyid(p.proowner) AS owner,
              p.proconfig::text AS config,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
              (SELECT count(*)::int FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_grants
         FROM pg_proc p
        WHERE p.oid IN ('public.fn_operation_create(uuid, date, text, public.operation_window_zone)'::regprocedure,
                        'public.fn_operation_transition(uuid, public.operation_status, public.operation_failure_code)'::regprocedure)
        ORDER BY 1`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row, row.fn).toMatchObject({
        definer: true,
        owner: "postgres",
        config: '{"search_path=public, pg_temp"}',
        authenticated: true,
        anon: false,
        service_role: false,
        public_grants: 0,
      });
    }
  });

  it("the guard trigger functions are SECURITY INVOKER and executable by no API role, and their triggers fire", () => {
    const fns = ownerRows<{ fn: string; definer: boolean; anon: boolean; authenticated: boolean; service_role: boolean }>(
      `SELECT p.proname AS fn, p.prosecdef AS definer,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('fn_operations_guard_update', 'fn_operation_evidence_while_running', 'fn_operation_evidence_guard_update')
        ORDER BY 1`,
    );
    expect(fns.map((f) => f.fn)).toEqual([
      "fn_operation_evidence_guard_update",
      "fn_operation_evidence_while_running",
      "fn_operations_guard_update",
    ]);
    for (const fn of fns) {
      expect(fn, fn.fn).toMatchObject({ definer: false, anon: false, authenticated: false, service_role: false });
    }

    const triggers = ownerRows<{ name: string; tbl: string; enabled: string; timing: string; events: string; level: string; fn: string }>(
      `SELECT t.tgname AS name, t.tgrelid::regclass::text AS tbl, t.tgenabled::text AS enabled,
              CASE WHEN t.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
              concat_ws(',', CASE WHEN t.tgtype & 4 = 4 THEN 'INSERT' END,
                             CASE WHEN t.tgtype & 8 = 8 THEN 'DELETE' END,
                             CASE WHEN t.tgtype & 16 = 16 THEN 'UPDATE' END) AS events,
              CASE WHEN t.tgtype & 1 = 1 THEN 'ROW' ELSE 'STATEMENT' END AS level,
              t.tgfoid::regproc::text AS fn
         FROM pg_trigger t
        WHERE NOT t.tgisinternal
          AND t.tgrelid IN ('public.operations'::regclass, 'public.operation_evidence'::regclass)
        ORDER BY 1`,
    );
    expect(triggers).toEqual([
      {
        name: "trg_operation_evidence_guard_update",
        tbl: "operation_evidence",
        enabled: "O",
        timing: "BEFORE",
        events: "UPDATE",
        level: "ROW",
        fn: "fn_operation_evidence_guard_update",
      },
      {
        name: "trg_operation_evidence_while_running",
        tbl: "operation_evidence",
        enabled: "O",
        timing: "BEFORE",
        events: "INSERT",
        level: "ROW",
        fn: "fn_operation_evidence_while_running",
      },
      {
        name: "trg_operations_guard_update",
        tbl: "operations",
        enabled: "O",
        timing: "BEFORE",
        events: "UPDATE",
        level: "ROW",
        fn: "fn_operations_guard_update",
      },
    ]);
  });

  it("neither table is published to realtime", () => {
    const rows = ownerRows<{ tablename: string }>(
      `SELECT tablename FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
          AND tablename IN ('operations', 'operation_evidence')`,
    );
    expect(rows).toEqual([]);
  });

  // A new column on either table goes into the guard triggers' enumerations
  // (fn_operations_guard_update, fn_operation_evidence_guard_update) in a new
  // migration, and into the mgm_agent column-grant decision (#274); update
  // these lists with them. This pin stands in for ems-guard-enumeration.test.ts.
  it("pins both tables' columns", () => {
    const columns = (table: string) =>
      ownerRows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = '${table}'
          ORDER BY ordinal_position`,
      ).map((r) => r.column_name);
    expect(columns("operations")).toEqual(OPERATION_COLUMNS);
    expect(columns("operation_evidence")).toEqual(EVIDENCE_COLUMNS);
  });

  it("no caller supplies an actor, an organization or a time (O3, E2)", () => {
    const rows = ownerRows<{ fn: string; args: string }>(
      `SELECT proname AS fn, proargnames::text AS args FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('fn_operation_create', 'fn_operation_transition')
        ORDER BY 1`,
    );
    expect(rows).toEqual([
      { fn: "fn_operation_create", args: "{_microgrid_id,_window_date,_window_tz,_window_zone}" },
      { fn: "fn_operation_transition", args: "{_operation_id,_to,_failure_code}" },
    ]);
  });

  // ── Direct writes refused (E1, E5) ─────────────────────────────────────

  async function directWrites(client: SupabaseClient, op: Operation) {
    const insertOperation = await client.from("operations").insert({
      microgrid_id: F.mgA,
      org_id: F.orgA,
      window_date: yesterdayIn(ZONE.mgA),
      window_tz: ZONE.mgA,
      window_zone: "microgrid",
    });
    const update = await client.from("operations").update({ status: "cancelled" }).eq("id", op.id).select("id");
    const remove = await client.from("operations").delete().eq("id", op.id).select("id");
    const insertEvidence = await client.from("operation_evidence").insert({
      operation_id: op.id,
      microgrid_id: op.microgrid_id,
      org_id: op.org_id,
      attempt_key: randomUUID(),
      schema_name: "site-day-evidence/1",
      outcome: "refused",
      content: { synthetic: true },
      size: 19,
    });
    return [insertOperation.error, update.error, remove.error, insertEvidence.error];
  }

  it("a manager's direct writes are refused and change nothing", async () => {
    const op = await createOnA();
    const before = countOperations(`org_id = '${F.orgA}'`);
    for (const error of await directWrites(managerA.client, op)) {
      expect(error?.code).toBe("42501");
    }
    expect(operationRow(op.id)).toMatchObject({ status: "running", ended_at: null });
    expect(countOperations(`org_id = '${F.orgA}'`)).toBe(before);
    expect(countEvidence(`operation_id = '${op.id}'`)).toBe(0);
  });

  it("the service role's direct writes are refused", async () => {
    const op = await createOnA();
    const before = countOperations(`org_id = '${F.orgA}'`);
    for (const error of await directWrites(await serviceClient(), op)) {
      expect(error?.code).toBe("42501");
    }
    expect(operationRow(op.id)).toMatchObject({ status: "running", ended_at: null });
    expect(countOperations(`org_id = '${F.orgA}'`)).toBe(before);
    expect(countEvidence(`operation_id = '${op.id}'`)).toBe(0);
  });

  it("the service role cannot call the write functions (E8)", async () => {
    const op = await createOnA();
    const before = countOperations(`microgrid_id = '${F.mgA}'`);
    const svc = await serviceClient();
    const created = await create(svc, {
      _microgrid_id: F.mgA,
      _window_date: yesterdayIn(ZONE.mgA),
      _window_tz: ZONE.mgA,
      _window_zone: "microgrid",
    });
    expectApiRoleRefused(created.error);
    const ended = await transition(svc, op.id, "cancelled");
    expectApiRoleRefused(ended.error);
    expect(countOperations(`microgrid_id = '${F.mgA}'`)).toBe(before);
    expect(operationRow(op.id)?.status).toBe("running");
  });

  it("anon reads neither table and calls neither function", async () => {
    const op = await createOnA();
    const anon = anonClient();
    for (const table of ["operations", "operation_evidence"]) {
      const { data, error } = await anon.from(table).select("id");
      expect(data).toBeNull();
      expectApiRoleRefused(error);
    }
    expectApiRoleRefused(
      (
        await create(anon, {
          _microgrid_id: F.mgA,
          _window_date: yesterdayIn(ZONE.mgA),
          _window_tz: ZONE.mgA,
          _window_zone: "microgrid",
        })
      ).error,
    );
    expectApiRoleRefused((await transition(anon, op.id, "cancelled")).error);
    expect(operationRow(op.id)?.status).toBe("running");
  });

  // ── Create (O1, O2, E1) ────────────────────────────────────────────────

  it("an org manager creates a running operation for yesterday, and reads it back", async () => {
    const date = yesterdayIn(ZONE.mgA);
    const { data, error } = await create(managerA.client, {
      _microgrid_id: F.mgA,
      _window_date: date,
      _window_tz: ZONE.mgA,
      _window_zone: "microgrid",
    });
    expect(error).toBeNull();
    const op = data as Operation;
    expect(op).toMatchObject({
      microgrid_id: F.mgA,
      org_id: F.orgA,
      window_date: date,
      window_tz: ZONE.mgA,
      window_zone: "microgrid",
      status: "running",
      failure_code: null,
      result: null,
      result_size: null,
      created_by: managerA.userId,
      ended_by: null,
      ended_at: null,
    });
    const read = await managerA.client.from("operations").select("id, status").eq("id", op.id);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([{ id: op.id, status: "running" }]);
  });

  it("only staff with access read an operation and its evidence", async () => {
    const opA = await createOnA();
    insertEvidenceOrThrow(opA);
    const { data: opB, error } = await create(managerB.client, {
      _microgrid_id: F.mgB,
      _window_date: yesterdayIn(ZONE.mgA),
      _window_tz: ZONE.mgA,
      _window_zone: "microgrid",
    });
    expect(error).toBeNull();

    for (const who of [managerB, tenantUser, noRole]) {
      const ops = await who.client.from("operations").select("id").eq("id", opA.id);
      expect(ops.error).toBeNull();
      expect(ops.data).toEqual([]);
      const evidence = await who.client.from("operation_evidence").select("id").eq("operation_id", opA.id);
      expect(evidence.error).toBeNull();
      expect(evidence.data).toEqual([]);
    }

    // managerB's own operation comes back, so an empty answer above is a
    // refusal, not a broken query.
    const own = await managerB.client.from("operations").select("id").eq("id", (opB as Operation).id);
    expect(own.data).toEqual([{ id: (opB as Operation).id }]);

    const sa = await superAdmin.client.from("operations").select("id").eq("id", opA.id);
    expect(sa.data).toEqual([{ id: opA.id }]);
    const saEvidence = await superAdmin.client.from("operation_evidence").select("operation_id").eq("operation_id", opA.id);
    expect(saEvidence.data).toEqual([{ operation_id: opA.id }]);
  });

  it("a super admin creates an operation", async () => {
    const op = await createOnA(superAdmin);
    expect(op).toMatchObject({ org_id: F.orgA, created_by: superAdmin.userId, status: "running" });
  });

  it("another organization's manager and an unknown microgrid get the same refusal", async () => {
    const before = countOperations(`microgrid_id = '${F.mgA}'`);
    const args = (microgridId: string): CreateArgs => ({
      _microgrid_id: microgridId,
      _window_date: yesterdayIn(ZONE.mgA),
      _window_tz: ZONE.mgA,
      _window_zone: "microgrid",
    });
    const other = await create(managerB.client, args(F.mgA));
    expectRefusal(other.error, "42501", "operations_forbidden");
    const unknown = await create(managerA.client, args(randomUUID()));
    expectRefusal(unknown.error, "42501", "operations_forbidden");
    expect(countOperations(`microgrid_id = '${F.mgA}'`)).toBe(before);
  });

  it("a tenant and an account with no role cannot create", async () => {
    for (const who of [tenantUser, noRole]) {
      const { error } = await create(who.client, {
        _microgrid_id: F.mgA,
        _window_date: yesterdayIn(ZONE.mgA),
        _window_tz: ZONE.mgA,
        _window_zone: "microgrid",
      });
      expectRefusal(error, "42501", "operations_forbidden");
    }
  });

  it("while the plugin is off, creation is refused after the access check", async () => {
    const args: CreateArgs = {
      _microgrid_id: F.mgA,
      _window_date: yesterdayIn(ZONE.mgA),
      _window_tz: ZONE.mgA,
      _window_zone: "microgrid",
    };
    const before = countOperations(`microgrid_id = '${F.mgA}'`);
    await setPlugin(F.orgA, false);
    try {
      expectRefusal((await create(managerA.client, args)).error, "55000", "operations_disabled");
      expectRefusal((await create(managerB.client, args)).error, "42501", "operations_forbidden");
    } finally {
      await setPlugin(F.orgA, true);
    }
    expect(countOperations(`microgrid_id = '${F.mgA}'`)).toBe(before);
  });

  it("with no plugin row, creation is refused: the plugin is off by default", async () => {
    await setPlugin(F.orgA, null);
    try {
      const { error } = await create(managerA.client, {
        _microgrid_id: F.mgA,
        _window_date: yesterdayIn(ZONE.mgA),
        _window_tz: ZONE.mgA,
        _window_zone: "microgrid",
      });
      expectRefusal(error, "55000", "operations_disabled");
    } finally {
      await setPlugin(F.orgA, true);
    }
  });

  it("refuses today and later in the microgrid's zone, east and west of UTC (O2)", async () => {
    const utcToday = todayIn("UTC");
    // Between them the two zones' dates differ from UTC's at every hour, so
    // a check made in UTC fails here whenever it runs.
    expect(
      todayIn(ZONE.mgAKiritimati) !== utcToday || todayIn(ZONE.mgAPagoPago) !== utcToday,
    ).toBe(true);

    for (const key of ["mgAKiritimati", "mgAPagoPago"] as const) {
      const microgridId = F[key];
      const tz = ZONE[key];
      const args = (date: string): CreateArgs => ({
        _microgrid_id: microgridId,
        _window_date: date,
        _window_tz: tz,
        _window_zone: "microgrid",
      });
      await withTodayIn(tz, async (today) => {
        const before = countOperations(`microgrid_id = '${microgridId}'`);
        expectRefusal((await create(managerA.client, args(today))).error, "22023", "window_not_closed");
        expectRefusal(
          (await create(managerA.client, args(addDaysToDateKey(today, 1)))).error,
          "22023",
          "window_not_closed",
        );
        expect(countOperations(`microgrid_id = '${microgridId}'`)).toBe(before);
        const { data, error } = await create(managerA.client, args(addDaysToDateKey(today, -1)));
        expect(error, key).toBeNull();
        expect(data).toMatchObject({ window_date: addDaysToDateKey(today, -1), window_tz: tz, window_zone: "microgrid" });
      });
    }
  });

  it("records a UTC fallback for a stored zone that is not valid, and refuses a zone the database does not know", async () => {
    const date = yesterdayIn("UTC");
    const { data, error } = await create(managerA.client, {
      _microgrid_id: F.mgABadZone,
      _window_date: date,
      _window_tz: "UTC",
      _window_zone: "fallback",
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ window_zone: "fallback", window_tz: "UTC", window_date: date });

    const unknown = await create(managerA.client, {
      _microgrid_id: F.mgABadZone,
      _window_date: date,
      _window_tz: ZONE.mgABadZone,
      _window_zone: "microgrid",
    });
    expectRefusal(unknown.error, "22023", "window_zone_unrecognised");
  });

  it("refuses a zone pair that does not match the stored zone (O2)", async () => {
    const cases: [string, string, "microgrid" | "fallback"][] = [
      [F.mgA, "Europe/London", "microgrid"],
      [F.mgAUtc, "UTC", "fallback"],
      [F.mgABadZone, "Africa/Kampala", "fallback"],
    ];
    for (const [microgridId, tz, zone] of cases) {
      const before = countOperations(`microgrid_id = '${microgridId}'`);
      const { error } = await create(managerA.client, {
        _microgrid_id: microgridId,
        _window_date: addDaysToDateKey(todayIn("UTC"), -2),
        _window_tz: tz,
        _window_zone: zone,
      });
      expectRefusal(error, "22023", "window_zone_stale");
      expect(countOperations(`microgrid_id = '${microgridId}'`)).toBe(before);
    }
  });

  // The lenient check (investigation-evidence.md O2): the database does not
  // judge whether a stored zone is valid, so a UTC fallback claimed for a
  // valid stored zone is accepted, and fails at its first capture through
  // MGM with window_changed. If the check becomes strict, this becomes a
  // refusal in the same commit as the SQL.
  it("accepts a UTC fallback claimed for a valid stored zone", async () => {
    const date = addDaysToDateKey(todayIn("UTC"), -2);
    const { data, error } = await create(managerA.client, {
      _microgrid_id: F.mgA,
      _window_date: date,
      _window_tz: "UTC",
      _window_zone: "fallback",
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ microgrid_id: F.mgA, window_zone: "fallback", window_tz: "UTC", window_date: date });
  });

  // openSiteQuery never names a stored zone validateTimezone refuses: it
  // falls back to UTC. A 'microgrid' pair naming one would record that no
  // fallback happened, in a zone MGM does not use (header item 8).
  it("refuses a microgrid pair for a stored zone of a shape validateTimezone refuses, and accepts its UTC fallback (O2)", async () => {
    const date = addDaysToDateKey(todayIn("UTC"), -2);
    for (const key of ["mgAOffset", "mgAAbbrev"] as const) {
      const microgridId = F[key];
      const before = countOperations(`microgrid_id = '${microgridId}'`);
      const named = await create(managerA.client, {
        _microgrid_id: microgridId,
        _window_date: date,
        _window_tz: ZONE[key],
        _window_zone: "microgrid",
      });
      expectRefusal(named.error, "22023", "window_zone_stale");
      expect(countOperations(`microgrid_id = '${microgridId}'`)).toBe(before);

      const { data, error } = await create(managerA.client, {
        _microgrid_id: microgridId,
        _window_date: date,
        _window_tz: "UTC",
        _window_zone: "fallback",
      });
      expect(error, key).toBeNull();
      expect(data).toMatchObject({ microgrid_id: microgridId, window_zone: "fallback", window_tz: "UTC", window_date: date });
    }
  });

  it("refuses a missing argument with operation_request_invalid", async () => {
    const full: CreateArgs = {
      _microgrid_id: F.mgA,
      _window_date: yesterdayIn(ZONE.mgA),
      _window_tz: ZONE.mgA,
      _window_zone: "microgrid",
    };
    for (const key of Object.keys(full) as (keyof CreateArgs)[]) {
      const { error } = await create(managerA.client, { ...full, [key]: null });
      expectRefusal(error, "22023", "operation_request_invalid");
    }
  });

  it("a token with no user is refused first, by both functions", async () => {
    const op = await createOnA();
    const before = countOperations(`microgrid_id = '${F.mgA}'`);
    const nobody = await noSubjectClient();
    const valid: CreateArgs = {
      _microgrid_id: F.mgA,
      _window_date: yesterdayIn(ZONE.mgA),
      _window_tz: ZONE.mgA,
      _window_zone: "microgrid",
    };
    const empty: CreateArgs = { _microgrid_id: null, _window_date: null, _window_tz: null, _window_zone: null };
    for (const args of [valid, empty]) {
      expectRefusal((await create(nobody, args)).error, "42501", "operations_unauthenticated");
    }
    expectRefusal((await transition(nobody, op.id, "cancelled")).error, "42501", "operations_unauthenticated");
    expectRefusal((await transition(nobody, null, null)).error, "42501", "operations_unauthenticated");
    expect(countOperations(`microgrid_id = '${F.mgA}'`)).toBe(before);
    expect(operationRow(op.id)).toMatchObject({ status: "running", ended_at: null });
  });

  // ── Transition (O3, O4, E1, E3) ────────────────────────────────────────

  it("anyone with access cancels, and the canceller is recorded", async () => {
    for (const who of [managerA, superAdmin]) {
      const op = await createOnA(managerA);
      const { data, error } = await transition(who.client, op.id, "cancelled");
      expect(error).toBeNull();
      const ended = data as Operation;
      expect(ended).toMatchObject({
        id: op.id,
        status: "cancelled",
        failure_code: null,
        ended_by: who.userId,
        created_by: managerA.userId,
      });
      expect(ended.ended_at).not.toBeNull();
    }
  });

  it("records a metering refusal of the person as failed with access_refused", async () => {
    const op = await createOnA();
    const { data, error } = await transition(managerA.client, op.id, "failed", "access_refused");
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "failed", failure_code: "access_refused", ended_by: managerA.userId });
    expect((data as Operation).ended_at).not.toBeNull();
  });

  it("refuses every transition it does not drive, leaving the row unchanged", async () => {
    const op = await createOnA();
    const cases: [string | null, string | null][] = [
      ["completed", null],
      ["running", null],
      ["failed", null],
      ["failed", "expired"],
      ["failed", "no_successful_read"],
      ["failed", "window_changed"],
      ["failed", "evidence_too_large"],
      ["failed", "evidence_budget_full"],
      ["cancelled", "access_refused"],
      [null, null],
    ];
    for (const [to, code] of cases) {
      const { error } = await transition(managerA.client, op.id, to, code);
      expectRefusal(error, "22023", "operation_request_invalid");
    }
    // A missing operation id is the request's fault, whoever asks.
    for (const who of [managerA, noRole]) {
      expectRefusal((await transition(who.client, null, "cancelled")).error, "22023", "operation_request_invalid");
    }
    expect(operationRow(op.id)).toMatchObject({ status: "running", failure_code: null, ended_by: null, ended_at: null });
  });

  it("refuses a transition out of cancelled, failed and completed", async () => {
    const cancelled = await createOnA();
    expect((await transition(managerA.client, cancelled.id, "cancelled")).error).toBeNull();
    const failed = await createOnA();
    expect((await transition(managerA.client, failed.id, "failed", "access_refused")).error).toBeNull();
    const completed = await createOnA();
    const done = ownerAttempt(
      `UPDATE public.operations
          SET status = 'completed', result = '{"synthetic": true}'::jsonb, result_size = 19, ended_at = now()
        WHERE id = '${completed.id}'`,
    );
    expect(done.ok).toBe(true);

    for (const op of [cancelled, failed, completed]) {
      const before = operationRow(op.id);
      const { error } = await transition(managerA.client, op.id, "cancelled");
      expectRefusal(error, "55000", "operation_not_running");
      expect(operationRow(op.id)).toEqual(before);
    }
  });

  it("refuses a caller without access, and an unknown operation, alike", async () => {
    const op = await createOnA();
    for (const who of [managerB, tenantUser, noRole]) {
      expectRefusal((await transition(who.client, op.id, "cancelled")).error, "42501", "operations_forbidden");
    }
    expectRefusal((await transition(managerA.client, randomUUID(), "cancelled")).error, "42501", "operations_forbidden");
    expect(operationRow(op.id)).toMatchObject({ status: "running", ended_at: null });
  });

  it("while the plugin is off, cancel is refused and the operation stays readable", async () => {
    const op = await createOnA();
    insertEvidenceOrThrow(op);
    await setPlugin(F.orgA, false);
    try {
      expectRefusal((await transition(managerA.client, op.id, "cancelled")).error, "55000", "operations_disabled");
      // Access is checked before the plugin: a caller without access, and an
      // unknown operation, learn nothing about the organization's plugin.
      expectRefusal((await transition(managerB.client, op.id, "cancelled")).error, "42501", "operations_forbidden");
      expectRefusal((await transition(managerA.client, randomUUID(), "cancelled")).error, "42501", "operations_forbidden");
      expect(operationRow(op.id)?.status).toBe("running");
      const read = await managerA.client.from("operations").select("id, status").eq("id", op.id);
      expect(read.data).toEqual([{ id: op.id, status: "running" }]);
      const evidence = await managerA.client.from("operation_evidence").select("operation_id").eq("operation_id", op.id);
      expect(evidence.data).toEqual([{ operation_id: op.id }]);
    } finally {
      await setPlugin(F.orgA, true);
    }
  });

  it("a transition waiting on a concurrent cancel re-reads the row and is refused (E3)", async () => {
    const op = await createOnA();
    const { holder, contender } = await raceAgainstHeldTransaction(
      `  PERFORM 1 FROM public.operations WHERE id = '${op.id}' FOR UPDATE;
  UPDATE public.operations SET status = 'cancelled', ended_at = now() WHERE id = '${op.id}';`,
      () => transition(managerA.client, op.id, "failed", "access_refused"),
    );
    expect(holder.ok, holder.output).toBe(true);
    expectRefusal(contender.error, "55000", "operation_not_running");
    expect(operationRow(op.id)).toMatchObject({ status: "cancelled", failure_code: null, ended_by: null });
  });

  // ── Guards, as the owner (O1, O3, O4, E2, E3, E5) ──────────────────────

  it("an operation's microgrid, organization, window, creator and creation time are fixed", async () => {
    const op = await createOnA();
    const changes = [
      `microgrid_id = '${F.mgAUtc}'`,
      `org_id = '${F.orgB}'`,
      `window_date = window_date - 1`,
      `window_tz = 'Europe/London'`,
      `window_zone = 'fallback'`,
      `created_at = created_at - interval '1 day'`,
      `created_by = '${superAdmin.userId}'`,
    ];
    const before = operationRow(op.id);
    for (const change of changes) {
      const attempt = ownerAttempt(`UPDATE public.operations SET ${change} WHERE id = '${op.id}'`);
      expectOwnerRefusal(attempt, "55000", "operation_immutable");
    }
    expect(operationRow(op.id)).toEqual(before);
    // A resend of the same values is not a change.
    expect(ownerAttempt(`UPDATE public.operations SET microgrid_id = microgrid_id, status = status WHERE id = '${op.id}'`).ok).toBe(true);
  });

  it("an ended operation does not change status or outcome", async () => {
    const op = await createOnA();
    expect((await transition(managerA.client, op.id, "cancelled")).error).toBeNull();
    expectOwnerRefusal(
      ownerAttempt(`UPDATE public.operations SET status = 'running', ended_at = NULL, ended_by = NULL WHERE id = '${op.id}'`),
      "55000",
      "operation_transition_refused",
    );
    expectOwnerRefusal(
      ownerAttempt(`UPDATE public.operations SET status = 'failed', failure_code = 'access_refused' WHERE id = '${op.id}'`),
      "55000",
      "operation_transition_refused",
    );
    expectOwnerRefusal(
      ownerAttempt(`UPDATE public.operations SET ended_at = now() + interval '1 hour' WHERE id = '${op.id}'`),
      "55000",
      "operation_immutable",
    );
    expect(operationRow(op.id)?.status).toBe("cancelled");

    // With the status kept, no outcome column changes (O3, O4), and no
    // operation changes its id.
    const failed = await createOnA();
    expect((await transition(managerA.client, failed.id, "failed", "access_refused")).error).toBeNull();
    const completed = await createOnA();
    expect(
      ownerAttempt(
        `UPDATE public.operations
            SET status = 'completed', result = '{"synthetic": true}'::jsonb, result_size = 19, ended_at = now()
          WHERE id = '${completed.id}'`,
      ).ok,
    ).toBe(true);
    const running = await createOnA();
    const changes: [Operation, string][] = [
      [failed, `failure_code = 'window_changed'`],
      [op, `ended_by = '${superAdmin.userId}'`],
      [failed, `ended_by = '${superAdmin.userId}'`],
      [completed, `result = '{"changed": true}'::jsonb`],
      [completed, `result_size = result_size + 1`],
      [running, `id = '${randomUUID()}'`],
      [op, `id = '${randomUUID()}'`],
    ];
    const before = new Map([op, failed, completed, running].map((o) => [o.id, operationRow(o.id)]));
    for (const [target, change] of changes) {
      expectOwnerRefusal(
        ownerAttempt(`UPDATE public.operations SET ${change} WHERE id = '${target.id}'`),
        "55000",
        "operation_immutable",
      );
    }
    for (const [id, row] of before) expect(operationRow(id)).toEqual(row);
  });

  // The CHECK constraints hold for every writer, the owner included (§ 1.3).
  // Each case breaks exactly one constraint; the running operation is
  // unchanged after each, since every attempt rolls back.
  it("the operations CHECK constraints refuse an incoherent row", async () => {
    const op = await createOnA();
    const before = operationRow(op.id);
    const update = (set: string) => `UPDATE public.operations SET ${set} WHERE id = '${op.id}'`;
    const insert = (columns: string, values: string) =>
      `INSERT INTO public.operations (microgrid_id, org_id, window_date, ${columns})
       VALUES ('${F.mgA}', '${F.orgA}', current_date - 2, ${values})`;
    const cases: [string, string][] = [
      ["operations_result_when_completed", update(`status = 'completed', ended_at = now()`)],
      ["operations_failed_has_code", update(`status = 'failed', ended_at = now()`)],
      ["operations_ended_when_not_running", update(`status = 'cancelled'`)],
      ["operations_ended_after_created", update(`status = 'cancelled', ended_at = created_at - interval '1 second'`)],
      [
        "operations_expired_has_no_actor",
        update(`status = 'failed', failure_code = 'expired', ended_at = now(), ended_by = '${managerA.userId}'`),
      ],
      ["operations_result_is_object", update(`status = 'completed', ended_at = now(), result = '[]'::jsonb, result_size = 2`)],
      ["operations_result_size_with_result", update(`status = 'completed', ended_at = now(), result = '{}'::jsonb`)],
      [
        "operations_result_size_positive",
        update(`status = 'completed', ended_at = now(), result = '{}'::jsonb, result_size = 0`),
      ],
      [
        "operations_no_end_actor_while_running",
        insert("window_tz, window_zone, ended_by", `'${ZONE.mgA}', 'microgrid', '${managerA.userId}'`),
      ],
      ["operations_fallback_is_utc", insert("window_tz, window_zone", `'${ZONE.mgA}', 'fallback'`)],
      ["operations_window_tz_shape", insert("window_tz, window_zone", `'', 'microgrid'`)],
      ["operations_window_tz_shape", insert("window_tz, window_zone", `repeat('x', 65), 'microgrid'`)],
    ];
    const count = countOperations(`microgrid_id = '${F.mgA}'`);
    for (const [constraint, statement] of cases) {
      expectCheckViolation(ownerAttempt(statement), constraint);
    }
    expect(operationRow(op.id)).toEqual(before);
    expect(countOperations(`microgrid_id = '${F.mgA}'`)).toBe(count);
  });

  it("the evidence CHECK constraints refuse an incoherent row", async () => {
    const op = await createOnA();
    const insert = (schema: string, content: string, size: number) =>
      `INSERT INTO public.operation_evidence
              (operation_id, microgrid_id, org_id, attempt_key, schema_name, outcome, content, size)
       VALUES ('${op.id}', '${op.microgrid_id}', '${op.org_id}', '${randomUUID()}', '${schema}', 'refused', '${content}'::jsonb, ${size})`;
    const cases: [string, string][] = [
      ["operation_evidence_schema_known", insert("other/1", '{"synthetic": true}', 19)],
      ["operation_evidence_content_is_object", insert("site-day-evidence/1", "[]", 2)],
      ["operation_evidence_size_positive", insert("site-day-evidence/1", '{"synthetic": true}', 0)],
    ];
    for (const [constraint, statement] of cases) {
      expectCheckViolation(ownerAttempt(statement), constraint);
    }
    expect(countEvidence(`operation_id = '${op.id}'`)).toBe(0);
  });

  it("evidence carries its operation's microgrid and organization (E2)", async () => {
    const op = await createOnA();
    expectOwnerRefusal(ownerAttempt(evidenceInsert(op, { microgridId: F.mgAUtc })), "23503");
    expectOwnerRefusal(ownerAttempt(evidenceInsert(op, { orgId: F.orgB })), "23503");
    expect(ownerAttempt(evidenceInsert(op)).ok).toBe(true);
    expect(countEvidence(`operation_id = '${op.id}'`)).toBe(1);
  });

  it("evidence is not written for an operation that has ended (E3)", async () => {
    const op = await createOnA();
    expect((await transition(managerA.client, op.id, "cancelled")).error).toBeNull();
    expectOwnerRefusal(ownerAttempt(evidenceInsert(op)), "55000", "operation_not_running");
    expect(countEvidence(`operation_id = '${op.id}'`)).toBe(0);
  });

  it("an evidence insert waiting on a concurrent cancel is refused (E3, for every writer)", async () => {
    const op = await createOnA();
    const { holder, contender } = await raceAgainstHeldTransaction(
      `  PERFORM 1 FROM public.operations WHERE id = '${op.id}' FOR UPDATE;
  UPDATE public.operations SET status = 'cancelled', ended_at = now() WHERE id = '${op.id}';`,
      async () => ownerAttempt(evidenceInsert(op)),
    );
    expect(holder.ok, holder.output).toBe(true);
    expectOwnerRefusal(contender, "55000", "operation_not_running");
    expect(countEvidence(`operation_id = '${op.id}'`)).toBe(0);
  });

  it("one successful read and one record per attempt key (E4)", async () => {
    const op = await createOnA();
    const key = randomUUID();
    insertEvidenceOrThrow(op, { outcome: "read", attemptKey: key });
    expectOwnerRefusal(ownerAttempt(evidenceInsert(op, { outcome: "read" })), "23505");
    expectOwnerRefusal(ownerAttempt(evidenceInsert(op, { outcome: "refused", attemptKey: key })), "23505");
    expect(countEvidence(`operation_id = '${op.id}'`)).toBe(1);
  });

  it("evidence is immutable (E5)", async () => {
    const op = await createOnA();
    insertEvidenceOrThrow(op, { capturedBy: managerA.userId });
    // Running operations to move the evidence to: one with the same
    // microgrid and organization, so the foreign key alone would allow it,
    // and one on another microgrid of the same organization.
    const sameSite = await createOnA();
    const { data: otherData, error: otherError } = await create(managerA.client, {
      _microgrid_id: F.mgAUtc,
      _window_date: yesterdayIn(ZONE.mgAUtc),
      _window_tz: ZONE.mgAUtc,
      _window_zone: "microgrid",
    });
    expect(otherError).toBeNull();
    const otherSite = otherData as Operation;
    const changes = [
      `id = '${randomUUID()}'`,
      `attempt_key = '${randomUUID()}'`,
      `schema_name = 'other/1'`,
      `content = '{"changed": true}'::jsonb`,
      `size = size + 1`,
      `outcome = 'read'`,
      `captured_at = captured_at - interval '1 day'`,
      `captured_by = '${superAdmin.userId}'`,
      `operation_id = '${sameSite.id}'`,
      `operation_id = '${otherSite.id}', microgrid_id = '${otherSite.microgrid_id}', org_id = '${otherSite.org_id}'`,
    ];
    for (const change of changes) {
      expectOwnerRefusal(
        ownerAttempt(`UPDATE public.operation_evidence SET ${change} WHERE operation_id = '${op.id}'`),
        "55000",
        "operation_evidence_immutable",
      );
    }
    expect(
      ownerRows<{ captured_by: string }>(`SELECT captured_by FROM public.operation_evidence WHERE operation_id = '${op.id}'`),
    ).toEqual([{ captured_by: managerA.userId }]);
    expect(countEvidence(`operation_id IN ('${sameSite.id}', '${otherSite.id}')`)).toBe(0);
  });

  // ── Users and cascade (O3, E5, § 9) ────────────────────────────────────

  it("deleting a user nulls their references and changes nothing else", async () => {
    const deletable = await createTestUser({ email: EMAIL.deletable, role: "org_manager", scopeId: F.orgA });
    const op = await createOnA(deletable);
    insertEvidenceOrThrow(op, { capturedBy: deletable.userId });
    expect((await transition(deletable.client, op.id, "cancelled")).error).toBeNull();
    const before = operationRow(op.id)!;
    expect(before).toMatchObject({ created_by: deletable.userId, ended_by: deletable.userId, status: "cancelled" });

    const svc = await serviceClient();
    const { error } = await svc.auth.admin.deleteUser(deletable.userId);
    expect(error).toBeNull();

    expect(operationRow(op.id)).toEqual({ ...before, created_by: null, ended_by: null });
    const evidence = ownerRows<{ captured_by: string | null; content: unknown }>(
      `SELECT captured_by, content FROM public.operation_evidence WHERE operation_id = '${op.id}'`,
    );
    expect(evidence).toEqual([{ captured_by: null, content: { synthetic: true } }]);
  });

  it("deleting a microgrid removes its operations and evidence", async () => {
    const running = await createOnA(managerA, F.mgACascade);
    insertEvidenceOrThrow(running);
    const cancelled = await createOnA(managerA, F.mgACascade);
    insertEvidenceOrThrow(cancelled);
    expect((await transition(managerA.client, cancelled.id, "cancelled")).error).toBeNull();

    const { error } = await managerA.client.rpc("fn_entity_delete_microgrid", { p_id: F.mgACascade });
    expect(error).toBeNull();
    expect(countOperations(`microgrid_id = '${F.mgACascade}'`)).toBe(0);
    expect(countEvidence(`microgrid_id = '${F.mgACascade}'`)).toBe(0);
  });

  it("deleting an organization removes its operations and evidence", async () => {
    const op = await createOnA(superAdmin, F.mgC);
    expect(op.org_id).toBe(F.orgC);
    insertEvidenceOrThrow(op);

    const { data, error } = await superAdmin.client.rpc("fn_entity_delete_org", { p_id: F.orgC });
    expect(error).toBeNull();
    expect(data).toBe(1);
    expect(countOperations(`org_id = '${F.orgC}'`)).toBe(0);
    expect(countEvidence(`org_id = '${F.orgC}'`)).toBe(0);
  });
});
