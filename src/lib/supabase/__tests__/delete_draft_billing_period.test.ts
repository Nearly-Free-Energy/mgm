/**
 * delete_draft_billing_period.test.ts (migration 20261120130000)
 *
 * fn_delete_draft_billing_period, against a live local Supabase through
 * PostgREST:
 *   - an org manager of the period's organization, and a super admin, delete
 *     a draft period with it; its bills and history go with it;
 *   - a closed period, a period with payment activity and a period a pilot
 *     import refers to are refused with the errors the billing capability
 *     maps (fn_billing_period_before_delete_guard's, and 23503);
 *   - another organization's manager, a tenant of the period's microgrid
 *     and an account with no role delete nothing and get NULL; anon cannot
 *     call it;
 *   - signed-in callers hold no DELETE on billing_periods, so a direct
 *     PostgREST delete is refused; service_role keeps it;
 *   - deleting a microgrid with an unpaid draft still removes the period, by
 *     cascade (keep_closed_and_paid_billing.test.ts covers the organization
 *     and community deletes);
 *   - the function's definition: SECURITY DEFINER, owned by postgres, with a
 *     pinned search_path and no EXECUTE for anon.
 *
 * Self-fixturing; honors `SKIP_RLS_TESTS=1` for runs without local Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  createTestUser,
  runAsDatabaseOwner,
  LOCAL_SUPABASE_URL,
  testAnonKey,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[delete_draft_billing_period] SKIP_RLS_TESTS=1 — skipping suite.");
}

const F = {
  org: "dd5e0000-0000-4000-8000-00000000000a",
  otherOrg: "dd5e0000-0000-4000-8000-00000000000b",
  community: "dd5e0000-0000-4000-8001-00000000000a",
  otherCommunity: "dd5e0000-0000-4000-8001-00000000000b",
  mg: "dd5e0000-0000-4000-8002-00000000000a",
  mgCascade: "dd5e0000-0000-4000-8002-00000000000b",
  otherMg: "dd5e0000-0000-4000-8002-00000000000c",
  tenant: "dd5e0000-0000-4000-8005-00000000000a",
  tenantCascade: "dd5e0000-0000-4000-8005-00000000000b",
  merchant: "dd5e0000-0000-4000-8008-00000000000a",

  periodByManager: "dd5e0000-0000-4000-8006-000000000001",
  periodBySuperAdmin: "dd5e0000-0000-4000-8006-000000000002",
  periodClosed: "dd5e0000-0000-4000-8006-000000000003",
  periodPaid: "dd5e0000-0000-4000-8006-000000000004",
  periodAttempt: "dd5e0000-0000-4000-8006-000000000005",
  periodEvent: "dd5e0000-0000-4000-8006-000000000006",
  periodImported: "dd5e0000-0000-4000-8006-000000000007",
  periodRefused: "dd5e0000-0000-4000-8006-000000000008",
  periodServiceRole: "dd5e0000-0000-4000-8006-000000000009",
  periodBillingOff: "dd5e0000-0000-4000-8006-00000000000f",
  periodCascade: "dd5e0000-0000-4000-8006-00000000000a",

  lineByManager: "dd5e0000-0000-4000-8007-000000000001",
  linePaid: "dd5e0000-0000-4000-8007-000000000004",
  lineAttempt: "dd5e0000-0000-4000-8007-000000000005",
  lineEvent: "dd5e0000-0000-4000-8007-000000000006",
  lineRefused: "dd5e0000-0000-4000-8007-000000000008",
  lineCascade: "dd5e0000-0000-4000-8007-00000000000a",

  attempt: "dd5e0000-0000-4000-8009-000000000005",
  importBatch: "dd5e0000-0000-4000-800a-000000000007",
};

const STAMP = Date.now();
const EMAIL = {
  manager: `ddbp-mgr-${STAMP}@test.local`,
  superAdmin: `ddbp-sa-${STAMP}@test.local`,
  otherManager: `ddbp-other-${STAMP}@test.local`,
  tenant: `ddbp-tenant-${STAMP}@test.local`,
  noRole: `ddbp-norole-${STAMP}@test.local`,
};

let manager: TestUser;
let superAdmin: TestUser;
let otherManager: TestUser;
let tenantUser: TestUser;
let noRole: TestUser;

async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(`[delete_draft_billing_period] fixture insert failed on ${table}: ${error.message}`);
  }
}

async function periodExists(id: string): Promise<boolean> {
  const svc = await serviceClient();
  const { data, error } = await svc.from("billing_periods").select("id").eq("id", id);
  if (error) throw new Error(error.message);
  return (data ?? []).length === 1;
}

function period(id: string, microgridId: string, month: string, status: "draft" | "closed") {
  const [year, mm] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return {
    id,
    microgrid_id: microgridId,
    start_date: `${month}-01`,
    end_date: `${month}-${String(lastDay).padStart(2, "0")}`,
    status,
    closed_at: status === "closed" ? new Date().toISOString() : null,
  };
}

function lineItem(id: string, periodId: string, tenantId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    billing_period_id: periodId,
    tenant_id: tenantId,
    usage_kwh: 10,
    total_amount: 5000,
    // Spelled out on every row: a multi-row insert sends the union of keys.
    payment_status: "unpaid",
    paid_at: null,
    ...extra,
  };
}

function ownerQuery<T>(sql: string): T[] {
  const result = runAsDatabaseOwner(sql);
  if (!result.ok) throw new Error(`[delete_draft_billing_period] owner query failed: ${result.output}`);
  return JSON.parse(result.stdout) as T[];
}

// pilot_import_batches and payment_merchant_versions refer to these
// fixtures without ON DELETE CASCADE, so their rows go first; the
// organizations hold kept billing, so cleanupTestData purges them as the
// database owner.
async function cleanupFixtures(): Promise<void> {
  const batches = runAsDatabaseOwner(
    `DELETE FROM public.pilot_import_batches WHERE id = '${F.importBatch}'`,
  );
  if (!batches.ok) throw new Error(`[delete_draft_billing_period] cleanup failed: ${batches.output}`);
  const svc = await serviceClient();
  const plugins = await svc.from("mgm_plugins").delete().in("org_id", [F.org, F.otherOrg]);
  if (plugins.error) throw new Error(`[delete_draft_billing_period] cleanup failed: ${plugins.error.message}`);
  const { error } = await svc.from("payment_merchant_versions").delete().in("org_id", [F.org, F.otherOrg]);
  if (error) throw new Error(`[delete_draft_billing_period] cleanup failed: ${error.message}`);
  await cleanupTestData({ orgIds: [F.org, F.otherOrg], userEmails: Object.values(EMAIL) });
}

desc("20261120130000_billing_period_delete_function.sql", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();
    await cleanupFixtures();

    await insertOrThrow(svc, "organizations", [
      { id: F.org, name: "Delete Function Org" },
      { id: F.otherOrg, name: "Delete Function Other Org" },
    ]);
    await insertOrThrow(svc, "communities", [
      { id: F.community, org_id: F.org, name: "DF Comm" },
      { id: F.otherCommunity, org_id: F.otherOrg, name: "DF Other Comm" },
    ]);
    await insertOrThrow(svc, "microgrids", [
      { id: F.mg, community_id: F.community, name: "DF MG", currency: "UGX" },
      { id: F.mgCascade, community_id: F.community, name: "DF MG cascade", currency: "UGX" },
      { id: F.otherMg, community_id: F.otherCommunity, name: "DF Other MG", currency: "UGX" },
    ]);
    await insertOrThrow(svc, "tenants", [
      { id: F.tenant, microgrid_id: F.mg, display_name: "DF Tenant", primary_phone: "+256700000011" },
      { id: F.tenantCascade, microgrid_id: F.mgCascade, display_name: "DF Tenant cascade", primary_phone: "+256700000012" },
    ]);
    await insertOrThrow(svc, "billing_periods", [
      period(F.periodByManager, F.mg, "2025-01", "draft"),
      period(F.periodBySuperAdmin, F.mg, "2025-02", "draft"),
      period(F.periodClosed, F.mg, "2025-03", "closed"),
      period(F.periodPaid, F.mg, "2025-04", "draft"),
      period(F.periodAttempt, F.mg, "2025-05", "draft"),
      period(F.periodEvent, F.mg, "2025-06", "draft"),
      period(F.periodImported, F.mg, "2025-07", "draft"),
      period(F.periodRefused, F.mg, "2025-08", "draft"),
      period(F.periodServiceRole, F.mg, "2025-09", "draft"),
      period(F.periodBillingOff, F.mg, "2025-10", "draft"),
      period(F.periodCascade, F.mgCascade, "2025-01", "draft"),
    ]);
    await insertOrThrow(svc, "billing_line_items", [
      lineItem(F.lineByManager, F.periodByManager, F.tenant),
      lineItem(F.linePaid, F.periodPaid, F.tenant, { payment_status: "paid", paid_at: new Date().toISOString() }),
      lineItem(F.lineAttempt, F.periodAttempt, F.tenant),
      lineItem(F.lineEvent, F.periodEvent, F.tenant),
      lineItem(F.lineRefused, F.periodRefused, F.tenant),
      lineItem(F.lineCascade, F.periodCascade, F.tenantCascade),
    ]);
    await insertOrThrow(svc, "billing_audit_log", {
      billing_period_id: F.periodByManager,
      billing_line_item_id: F.lineByManager,
      event_type: "line_item_generated",
      actor_kind: "system",
      actor_ref: "delete_draft_billing_period_test",
      details: {},
    });
    await insertOrThrow(svc, "payment_merchant_accounts", {
      id: F.merchant,
      org_id: F.org,
      display_name: "DF merchant",
    });
    await insertOrThrow(svc, "payment_attempts", {
      id: F.attempt,
      org_id: F.org,
      line_item_id: F.lineAttempt,
      community_id: F.community,
      merchant_account_id: F.merchant,
      merchant_account_version: 1,
      amount: 5000,
      merchant_reference: `DF-${F.attempt}`,
    });
    await insertOrThrow(svc, "payment_events", {
      line_item_id: F.lineEvent,
      from_status: "unpaid",
      to_status: "link_generated",
      source: "generate_link",
      actor_kind: "system",
      actor_ref: "delete_draft_billing_period_test",
    });
    ownerQuery(
      `INSERT INTO public.pilot_import_batches (id, billing_period_id, source_label)
       VALUES ('${F.importBatch}', '${F.periodImported}', 'synthetic-pilot') RETURNING id`,
    );

    manager = await createTestUser({ email: EMAIL.manager, role: "org_manager", scopeId: F.org });
    superAdmin = await createTestUser({ email: EMAIL.superAdmin, role: "super_admin" });
    otherManager = await createTestUser({ email: EMAIL.otherManager, role: "org_manager", scopeId: F.otherOrg });
    tenantUser = await createTestUser({ email: EMAIL.tenant, role: "tenant", scopeId: F.tenant });
    noRole = await createTestUser({ email: EMAIL.noRole, role: null });
  }, 120_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupFixtures();
  }, 60_000);

  it("an org manager deletes their organization's draft, with its bills and history", async () => {
    const { data, error } = await manager.client.rpc("fn_delete_draft_billing_period", {
      _period_id: F.periodByManager,
    });
    expect(error).toBeNull();
    expect(data).toBe(F.periodByManager);
    expect(await periodExists(F.periodByManager)).toBe(false);

    const svc = await serviceClient();
    const { data: lines } = await svc.from("billing_line_items").select("id").eq("id", F.lineByManager);
    expect(lines ?? []).toHaveLength(0);
    const { data: audit } = await svc.from("billing_audit_log").select("id").eq("billing_period_id", F.periodByManager);
    expect(audit ?? []).toHaveLength(0);
  });

  it("a super admin deletes a draft", async () => {
    const { data, error } = await superAdmin.client.rpc("fn_delete_draft_billing_period", {
      _period_id: F.periodBySuperAdmin,
    });
    expect(error).toBeNull();
    expect(data).toBe(F.periodBySuperAdmin);
    expect(await periodExists(F.periodBySuperAdmin)).toBe(false);
  });

  it("a closed period is kept, with the guard's error", async () => {
    const { data, error } = await manager.client.rpc("fn_delete_draft_billing_period", {
      _period_id: F.periodClosed,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("23514");
    expect(error?.message).toMatch(/^billing_period_kept/);
    expect(error?.details).toBe("closed");
    expect(await periodExists(F.periodClosed)).toBe(true);
  });

  it.each([
    ["a paid bill", "periodPaid"],
    ["a payment attempt", "periodAttempt"],
    ["a payment event", "periodEvent"],
  ] as const)("a draft with %s is kept, with the guard's error", async (_label, key) => {
    const { data, error } = await manager.client.rpc("fn_delete_draft_billing_period", {
      _period_id: F[key],
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("23514");
    expect(error?.message).toMatch(/^billing_period_kept/);
    expect(error?.details).toBe("payment_activity");
    expect(await periodExists(F[key])).toBe(true);
  });

  it("while billing is off, a direct call keeps the draft and raises billing_disabled", async () => {
    const svc = await serviceClient();
    const setBilling = async (enabled: boolean) => {
      const { error } = await svc
        .from("mgm_plugins")
        .upsert({ org_id: F.org, plugin_name: "billing", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
      if (error) throw new Error(`[delete_draft_billing_period] mgm_plugins: ${error.message}`);
    };
    await setBilling(false);
    try {
      const { data, error } = await manager.client.rpc("fn_delete_draft_billing_period", {
        _period_id: F.periodBillingOff,
      });
      expect(data).toBeNull();
      expect(error?.code).toBe("55000");
      expect(error?.message).toMatch(/^billing_disabled/);
      expect(await periodExists(F.periodBillingOff)).toBe(true);
      // Someone who may not see the period still gets NULL, not the gate's answer.
      const other = await otherManager.client.rpc("fn_delete_draft_billing_period", { _period_id: F.periodBillingOff });
      expect(other).toMatchObject({ data: null, error: null });
    } finally {
      await setBilling(true);
    }
    const { data, error } = await manager.client.rpc("fn_delete_draft_billing_period", {
      _period_id: F.periodBillingOff,
    });
    expect(error).toBeNull();
    expect(data).toBe(F.periodBillingOff);
  });

  it("a draft a pilot import refers to is refused with 23503", async () => {
    const { data, error } = await manager.client.rpc("fn_delete_draft_billing_period", {
      _period_id: F.periodImported,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("23503");
    expect(await periodExists(F.periodImported)).toBe(true);
  });

  it("another organization's manager, a tenant and an account with no role delete nothing", async () => {
    for (const who of [otherManager, tenantUser, noRole]) {
      const { data, error } = await who.client.rpc("fn_delete_draft_billing_period", {
        _period_id: F.periodRefused,
      });
      expect(error).toBeNull();
      expect(data).toBeNull();
    }
    expect(await periodExists(F.periodRefused)).toBe(true);
    const svc = await serviceClient();
    const { data: lines } = await svc.from("billing_line_items").select("id").eq("id", F.lineRefused);
    expect(lines ?? []).toHaveLength(1);
  });

  it("anon cannot call it", async () => {
    const anon = createClient(LOCAL_SUPABASE_URL, testAnonKey()!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await anon.rpc("fn_delete_draft_billing_period", { _period_id: F.periodRefused });
    expect(data).toBeNull();
    expect(
      error?.code === "42501" ||
        error?.message?.toLowerCase().includes("permission denied") ||
        error?.code === "PGRST202",
    ).toBe(true);
    expect(await periodExists(F.periodRefused)).toBe(true);
  });

  it("a signed-in caller's direct delete through PostgREST is refused", async () => {
    for (const who of [manager, superAdmin]) {
      const { data, error } = await who.client.from("billing_periods").delete().eq("id", F.periodRefused).select("id");
      expect(error?.code).toBe("42501");
      expect(data).toBeNull();
    }
    expect(await periodExists(F.periodRefused)).toBe(true);
  });

  it("service_role still deletes a draft directly", async () => {
    const svc = await serviceClient();
    const { data, error } = await svc.from("billing_periods").delete().eq("id", F.periodServiceRole).select("id");
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    expect(await periodExists(F.periodServiceRole)).toBe(false);
  });

  it("an org manager still deletes a microgrid with an unpaid draft, which goes by cascade", async () => {
    const { error } = await manager.client.rpc("fn_entity_delete_microgrid", { p_id: F.mgCascade });
    expect(error).toBeNull();
    expect(await periodExists(F.periodCascade)).toBe(false);
    const svc = await serviceClient();
    const { data: lines } = await svc.from("billing_line_items").select("id").eq("id", F.lineCascade);
    expect(lines ?? []).toHaveLength(0);
  });

  it("signed-in roles hold no DELETE on billing_periods; their other privileges stay", () => {
    const [row] = ownerQuery<Record<string, boolean>>(`
      SELECT
        has_table_privilege('authenticated', 'public.billing_periods', 'DELETE') AS auth_delete,
        has_table_privilege('anon', 'public.billing_periods', 'DELETE') AS anon_delete,
        has_table_privilege('service_role', 'public.billing_periods', 'DELETE') AS svc_delete,
        has_table_privilege('authenticated', 'public.billing_periods', 'SELECT') AS auth_select,
        has_table_privilege('authenticated', 'public.billing_periods', 'INSERT') AS auth_insert,
        has_table_privilege('authenticated', 'public.billing_periods', 'UPDATE') AS auth_update`);
    expect(row).toEqual({
      auth_delete: false,
      anon_delete: false,
      svc_delete: true,
      auth_select: true,
      auth_insert: true,
      auth_update: true,
    });
  });

  it("is SECURITY DEFINER, owned by postgres, with a pinned search_path, and not executable by anon", () => {
    const [row] = ownerQuery<Record<string, unknown>>(`
      SELECT p.prosecdef AS definer,
             pg_get_userbyid(p.proowner) AS owner,
             p.proconfig AS config,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_exec
      FROM pg_proc p
      WHERE p.oid = 'public.fn_delete_draft_billing_period(uuid)'::regprocedure`);
    expect(row.definer).toBe(true);
    expect(row.owner).toBe("postgres");
    expect(row.config).toEqual(["search_path=public, pg_temp"]);
    expect(row.anon_exec).toBe(false);
    expect(row.auth_exec).toBe(true);
    expect(row.svc_exec).toBe(true);
  });
});
