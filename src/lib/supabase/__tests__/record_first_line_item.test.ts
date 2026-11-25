/**
 * record_first_line_item.test.ts (migration 20261120130100)
 *
 * fn_record_first_line_item_with_audit and
 * trg_billing_line_item_insert_closed_period_guard, against a live local
 * Supabase through PostgREST:
 *   - an org manager's first bill for a tenant in a draft is written as
 *     fn_record_line_item_with_audit writes one from the same inputs, with one
 *     line_item_generated audit row;
 *   - a tenant who has a bill, a closed period and a moved tariff pin are
 *     refused, writing nothing; the closed period by the function's own check,
 *     for service_role too, which the insert guard below lets through;
 *     another organization's manager and a tenant find no period; anon cannot
 *     call it;
 *   - races, each with the other transaction holding its locks first: a
 *     close makes the insert find the period closed, a bill inserted by
 *     another write makes it refuse with bill_exists and leave that bill as
 *     it is, and a first bill makes a close reviewed before it refuse with
 *     billing_close_totals_changed;
 *   - the insert guard refuses a signed-in caller's direct insert into a
 *     closed period, and lets through a draft's insert, the audited write of
 *     fn_record_line_item_with_audit (Q4=B, #173) and
 *     service_role.
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
  raceAgainstHeldTransaction,
  LOCAL_SUPABASE_URL,
  testAnonKey,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[record_first_line_item] SKIP_RLS_TESTS=1 — skipping suite.");
}

const F = {
  org: "f1b50000-0000-4000-8000-00000000000a",
  otherOrg: "f1b50000-0000-4000-8000-00000000000b",
  community: "f1b50000-0000-4000-8001-00000000000a",
  otherCommunity: "f1b50000-0000-4000-8001-00000000000b",
  mg: "f1b50000-0000-4000-8002-00000000000a",
  otherMg: "f1b50000-0000-4000-8002-00000000000b",
  edge: "f1b50000-0000-4000-8003-00000000000a",
  device: "f1b50000-0000-4000-8004-00000000000a",
  rate: "f1b50000-0000-4000-8005-00000000000a",
  otherRate: "f1b50000-0000-4000-8005-00000000000b",

  draft: "f1b50000-0000-4000-8006-000000000001",
  closed: "f1b50000-0000-4000-8006-000000000002",
  raceClose: "f1b50000-0000-4000-8006-000000000003",
  raceInsert: "f1b50000-0000-4000-8006-000000000004",
  raceReviewed: "f1b50000-0000-4000-8006-000000000005",
};

// Tenants, one per case, so no case meets another's bill.
const T = Object.fromEntries(
  [
    "upsertManual",
    "firstManual",
    "upsertEdge",
    "firstEdge",
    "twice",
    "closed",
    "tariff",
    "notMine",
    "anon",
    "raceClose",
    "raceInsert",
    "raceReviewedBilled",
    "raceReviewed",
    "guardDraft",
    "guardClosed",
    "guardUpsert",
    "guardService",
    "closedService",
  ].map((name, i) => [name, `f1b50000-0000-4000-8007-${String(i + 1).padStart(12, "0")}`]),
) as Record<string, string>;

const STAMP = Date.now();
const EMAIL = {
  manager: `rfli-mgr-${STAMP}@test.local`,
  otherManager: `rfli-other-${STAMP}@test.local`,
  tenant: `rfli-tenant-${STAMP}@test.local`,
};

let manager: TestUser;
let otherManager: TestUser;
let tenantUser: TestUser;

async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(`[record_first_line_item] fixture insert failed on ${table}: ${error.message}`);
  }
}

function period(id: string, month: string, status: "draft" | "closed" = "draft") {
  const [year, mm] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return {
    id,
    microgrid_id: F.mg,
    start_date: `${month}-01`,
    end_date: `${month}-${String(lastDay).padStart(2, "0")}`,
    status,
    closed_at: status === "closed" ? new Date().toISOString() : null,
    rate_schedule_id: F.rate,
  };
}

/** The engine's arguments for a bill, as generate.ts sends them. */
function args(periodId: string, tenantId: string, over: Record<string, unknown> = {}) {
  return {
    _billing_period_id: periodId,
    _tenant_id: tenantId,
    _device_id: null,
    _usage_kwh: 12.34567,
    _start_kwh: 100.12345,
    _end_kwh: 112.46912,
    _tier_breakdown: [
      { label: "T1", kwh: 10.00049, amount: 2500.4 },
      { label: "T2", kwh: 2.34518, amount: 937.6 },
    ],
    _total_amount: 3438.4,
    _reading_source: "manual",
    _entered_by_user_id: manager.userId,
    _manual_reason: "meter offline",
    _actor_user_id: manager.userId,
    _audit_details: null,
    _rate_schedule_id: F.rate,
    ...over,
  };
}

async function billsOf(periodId: string, tenantId: string) {
  const svc = await serviceClient();
  const { data, error } = await svc
    .from("billing_line_items")
    .select("*")
    .eq("billing_period_id", periodId)
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function auditOf(lineItemId: string) {
  const svc = await serviceClient();
  const { data, error } = await svc
    .from("billing_audit_log")
    .select("event_type, actor_user_id, actor_kind, actor_ref, details")
    .eq("billing_line_item_id", lineItemId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** A bill's figures, without what differs between any two rows. */
function figures(row: Record<string, unknown>) {
  const rest = { ...row };
  for (const key of ["id", "tenant_id", "created_at", "updated_at", "entered_at", "short_slug"]) delete rest[key];
  return rest;
}

async function cleanupFixtures(): Promise<void> {
  await cleanupTestData({ orgIds: [F.org, F.otherOrg], userEmails: Object.values(EMAIL) });
}

desc("20261120130100_record_first_line_item.sql", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();
    await cleanupFixtures();

    await insertOrThrow(svc, "organizations", [
      { id: F.org, name: "First Bill Org" },
      { id: F.otherOrg, name: "First Bill Other Org" },
    ]);
    await insertOrThrow(svc, "communities", [
      { id: F.community, org_id: F.org, name: "FB Comm" },
      { id: F.otherCommunity, org_id: F.otherOrg, name: "FB Other Comm" },
    ]);
    await insertOrThrow(svc, "microgrids", [
      { id: F.mg, community_id: F.community, name: "FB MG", currency: "UGX" },
      { id: F.otherMg, community_id: F.otherCommunity, name: "FB Other MG", currency: "UGX" },
    ]);
    await insertOrThrow(svc, "edges", { id: F.edge, microgrid_id: F.mg, name: "FB Edge", openems_edge_id: "fb-edge" });
    await insertOrThrow(svc, "devices", {
      id: F.device,
      edge_id: F.edge,
      name: "FB Meter",
      device_type: "consumption_meter",
      openems_component_id: "fb-meter",
    });
    await insertOrThrow(
      svc,
      "tenants",
      Object.entries(T).map(([name, id], i) => ({
        id,
        microgrid_id: F.mg,
        display_name: `FB ${name}`,
        primary_phone: `+2567000${String(i).padStart(5, "0")}`,
      })),
    );
    await insertOrThrow(svc, "rate_schedules", [
      { id: F.rate, microgrid_id: F.mg, tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 250 }], service_charge: 0, tax_rate: 0 },
    ]);
    await insertOrThrow(svc, "billing_periods", [
      period(F.draft, "2025-01"),
      period(F.closed, "2025-02", "closed"),
      period(F.raceClose, "2025-03"),
      period(F.raceInsert, "2025-04"),
      period(F.raceReviewed, "2025-05"),
    ]);

    manager = await createTestUser({ email: EMAIL.manager, role: "org_manager", scopeId: F.org });
    otherManager = await createTestUser({ email: EMAIL.otherManager, role: "org_manager", scopeId: F.otherOrg });
    tenantUser = await createTestUser({ email: EMAIL.tenant, role: "tenant", scopeId: T.notMine });
  }, 120_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupFixtures();
  }, 60_000);

  describe("the first bill", () => {
    it.each([
      ["a manual reading", "upsertManual", "firstManual", {}],
      [
        "a meter reading",
        "upsertEdge",
        "firstEdge",
        { _reading_source: "edge", _device_id: F.device, _entered_by_user_id: null, _manual_reason: null },
      ],
    ] as const)("from %s is the row fn_record_line_item_with_audit writes, with one audit row", async (_label, upsertKey, firstKey, over) => {
      const viaUpsert = await manager.client.rpc("fn_record_line_item_with_audit", args(F.draft, T[upsertKey], over));
      expect(viaUpsert.error).toBeNull();
      const viaFirst = await manager.client.rpc("fn_record_first_line_item_with_audit", args(F.draft, T[firstKey], over));
      expect(viaFirst.error).toBeNull();

      const [upserted] = await billsOf(F.draft, T[upsertKey]);
      const [first] = await billsOf(F.draft, T[firstKey]);
      expect(viaFirst.data).toMatchObject({ id: first.id, tenant_id: T[firstKey] });
      expect(figures(first)).toEqual(figures(upserted));
      expect(first.entered_at === null).toBe(upserted.entered_at === null);
      expect(Number(first.usage_kwh)).toBe(12.346);
      expect(Number(first.total_amount)).toBe(3438);

      // The details are the function's (20261124170000): the same for both
      // writes but for the tenant's name.
      const manual = !("_reading_source" in over);
      const details = (tenantKey: string) => ({
        tenant_name: `FB ${tenantKey}`,
        previous_total_amount: null,
        new_total_amount: 3438,
        previous_reading_source: null,
        new_reading_source: manual ? "manual" : "edge",
        ...(manual ? { manual_reason: "meter offline" } : {}),
        rate_schedule_id: F.rate,
      });
      const audit = await auditOf(first.id);
      const row = { event_type: "line_item_generated", actor_user_id: manager.userId, actor_kind: "human", actor_ref: null };
      expect(audit).toEqual([{ ...row, details: details(firstKey) }]);
      expect(await auditOf(upserted.id)).toEqual([{ ...row, details: details(upsertKey) }]);
    });

    it("records a non-human actor as the upsert does", async () => {
      const svc = await serviceClient();
      const tenantId = T.guardService;
      const { error } = await svc.rpc(
        "fn_record_first_line_item_with_audit",
        args(F.draft, tenantId, { _actor_user_id: null, _entered_by_user_id: null, _actor_kind: "system", _actor_ref: "first-bill-test" }),
      );
      expect(error).toBeNull();
      const [bill] = await billsOf(F.draft, tenantId);
      expect(await auditOf(bill.id)).toMatchObject([{ actor_kind: "system", actor_ref: "first-bill-test", actor_user_id: null }]);
    });
  });

  describe("refusals, which write nothing", () => {
    it("a tenant who has a bill: billing_line_item_exists, and the bill stays as it was", async () => {
      const first = await manager.client.rpc("fn_record_first_line_item_with_audit", args(F.draft, T.twice));
      expect(first.error).toBeNull();
      const [before] = await billsOf(F.draft, T.twice);

      const { data, error } = await manager.client.rpc(
        "fn_record_first_line_item_with_audit",
        args(F.draft, T.twice, { _usage_kwh: 99, _total_amount: 99999, _manual_reason: "second" }),
      );
      expect(data).toBeNull();
      expect(error?.code).toBe("23514");
      expect(error?.message).toMatch(/^billing_line_item_exists/);
      expect(error?.details).toBe("bill_exists");
      expect(await billsOf(F.draft, T.twice)).toEqual([before]);
      expect(await auditOf(before.id)).toHaveLength(1);
    });

    // The function's own text, not the insert guard's ("a bill cannot be
    // added"), which refuses a signed-in caller with the same code and
    // DETAIL: these assertions fail if the function's check goes and only
    // the guard is left.
    const FUNCTION_CLOSED = /^billing_period_closed: a first bill is not added to a closed billing period$/;

    it("a closed period: billing_period_closed, by the function's own check", async () => {
      const { data, error } = await manager.client.rpc("fn_record_first_line_item_with_audit", args(F.closed, T.closed));
      expect(data).toBeNull();
      expect(error?.code).toBe("23514");
      expect(error?.message).toMatch(FUNCTION_CLOSED);
      expect(error?.details).toBe("closed");
      expect(await billsOf(F.closed, T.closed)).toEqual([]);
    });

    it("a closed period refuses service_role too, which the insert guard lets through", async () => {
      const svc = await serviceClient();
      const { data, error } = await svc.rpc(
        "fn_record_first_line_item_with_audit",
        args(F.closed, T.closedService, { _actor_user_id: null, _entered_by_user_id: null, _actor_kind: "system", _actor_ref: "first-bill-test" }),
      );
      expect(data).toBeNull();
      expect(error?.code).toBe("23514");
      expect(error?.message).toMatch(FUNCTION_CLOSED);
      expect(error?.details).toBe("closed");
      expect(await billsOf(F.closed, T.closedService)).toEqual([]);
    });

    it("a tariff pin that moved: the upsert's tariff text", async () => {
      const { data, error } = await manager.client.rpc(
        "fn_record_first_line_item_with_audit",
        args(F.draft, T.tariff, { _rate_schedule_id: F.otherRate }),
      );
      expect(data).toBeNull();
      expect(error?.code).toBe("23514");
      expect(error?.message).toBe("Billing period tariff changed; recalculate before writing bill");
      expect(await billsOf(F.draft, T.tariff)).toEqual([]);
    });

    it("another organization's manager and a tenant find no period", async () => {
      for (const who of [otherManager, tenantUser]) {
        // Entered by and naming the caller, as the function requires of a
        // signed-in caller (20261124170000), so the period is what it misses.
        const { data, error } = await who.client.rpc(
          "fn_record_first_line_item_with_audit",
          args(F.draft, T.notMine, { _entered_by_user_id: who.userId, _actor_user_id: who.userId }),
        );
        expect(data).toBeNull();
        expect(error?.code).toBe("P0002");
        expect(error?.message).toMatch(/^billing_period_not_found/);
      }
      expect(await billsOf(F.draft, T.notMine)).toEqual([]);
    });

    it("anon cannot call it", async () => {
      const anon = createClient(LOCAL_SUPABASE_URL, testAnonKey()!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await anon.rpc("fn_record_first_line_item_with_audit", args(F.draft, T.anon));
      expect(data).toBeNull();
      expect(
        error?.code === "42501" ||
          error?.message?.toLowerCase().includes("permission denied") ||
          error?.code === "PGRST202",
      ).toBe(true);
      expect(await billsOf(F.draft, T.anon)).toEqual([]);
    });
  });

  describe("races", () => {
    it("a close holding the period first: the insert waits, finds it closed and writes nothing", async () => {
      const { holder, contender } = await raceAgainstHeldTransaction(
        `  PERFORM 1 FROM billing_periods WHERE id = '${F.raceClose}' FOR UPDATE;
           UPDATE billing_periods SET status = 'closed', closed_at = now() WHERE id = '${F.raceClose}';`,
        () => manager.client.rpc("fn_record_first_line_item_with_audit", args(F.raceClose, T.raceClose)),
      );
      expect(holder.ok).toBe(true);
      expect(contender.data).toBeNull();
      // The function's own text: its FOR SHARE waits for the close before
      // its INSERT reaches the insert guard.
      expect(contender.error?.message).toMatch(
        /^billing_period_closed: a first bill is not added to a closed billing period$/,
      );
      expect(contender.error?.details).toBe("closed");
      expect(await billsOf(F.raceClose, T.raceClose)).toEqual([]);
    });

    it("a bill inserted by another write first: the insert waits, refuses with bill_exists and leaves that bill", async () => {
      const { holder, contender } = await raceAgainstHeldTransaction(
        `  INSERT INTO billing_line_items (billing_period_id, tenant_id, usage_kwh, total_amount)
           VALUES ('${F.raceInsert}', '${T.raceInsert}', 7, 1750);`,
        () => manager.client.rpc("fn_record_first_line_item_with_audit", args(F.raceInsert, T.raceInsert)),
      );
      expect(holder.ok).toBe(true);
      expect(contender.data).toBeNull();
      expect(contender.error?.message).toMatch(/^billing_line_item_exists/);
      const bills = await billsOf(F.raceInsert, T.raceInsert);
      expect(bills).toHaveLength(1);
      expect(Number(bills[0].usage_kwh)).toBe(7);
      expect(Number(bills[0].total_amount)).toBe(1750);
      expect(await auditOf(bills[0].id)).toEqual([]);
    });

    it("a first bill holding the period first: a close reviewed before it refuses with billing_close_totals_changed", async () => {
      const billed = await manager.client.rpc("fn_record_first_line_item_with_audit", args(F.raceReviewed, T.raceReviewedBilled));
      expect(billed.error).toBeNull();
      const review = await manager.client.rpc("fn_billing_period_close_review", { _period_id: F.raceReviewed });
      expect(review.error).toBeNull();
      const reviewed = review.data as { digest: string; acknowledgements: string[] };

      const { holder, contender } = await raceAgainstHeldTransaction(
        `  PERFORM fn_record_first_line_item_with_audit(
             '${F.raceReviewed}', '${T.raceReviewed}', NULL, 5, 0, 5, '[]'::jsonb, 1250,
             'manual', NULL, NULL, NULL, '{}'::jsonb, '${F.rate}', 'system', 'first-bill-race');`,
        () =>
          manager.client.rpc("fn_close_billing_period", {
            _period_id: F.raceReviewed,
            _digest: reviewed.digest,
            _acknowledged: reviewed.acknowledgements,
          }),
      );
      expect(holder.ok).toBe(true);
      expect(contender.error?.message).toMatch(/^billing_close_totals_changed/);
      const svc = await serviceClient();
      const { data } = await svc.from("billing_periods").select("status").eq("id", F.raceReviewed).single();
      expect(data?.status).toBe("draft");
      expect(await billsOf(F.raceReviewed, T.raceReviewed)).toHaveLength(1);
    });
  });

  describe("the closed-period insert guard", () => {
    const row = (periodId: string, tenantId: string) => ({
      billing_period_id: periodId,
      tenant_id: tenantId,
      usage_kwh: 3,
      total_amount: 750,
    });

    it("refuses a signed-in caller's direct insert into a closed period", async () => {
      const { error } = await manager.client.from("billing_line_items").insert(row(F.closed, T.guardClosed));
      expect(error?.code).toBe("23514");
      expect(error?.message).toMatch(/^billing_period_closed/);
      expect(error?.details).toBe("closed");
      expect(await billsOf(F.closed, T.guardClosed)).toEqual([]);
    });

    it("lets a signed-in caller's direct insert into a draft through", async () => {
      const { error } = await manager.client.from("billing_line_items").insert(row(F.draft, T.guardDraft));
      expect(error).toBeNull();
      expect(await billsOf(F.draft, T.guardDraft)).toHaveLength(1);
    });

    it("lets fn_record_line_item_with_audit add a tenant's bill to a closed period (Q4=B), marked in its audit row", async () => {
      const { error } = await manager.client.rpc("fn_record_line_item_with_audit", args(F.closed, T.guardUpsert));
      expect(error).toBeNull();
      const [bill] = await billsOf(F.closed, T.guardUpsert);
      expect(bill).toBeTruthy();
      expect(await auditOf(bill.id)).toMatchObject([
        { event_type: "line_item_generated", details: { period_was_closed: true } },
      ]);
    });

    it("lets service_role insert into a closed period", async () => {
      const svc = await serviceClient();
      const { error } = await svc.from("billing_line_items").insert(row(F.closed, T.guardService));
      expect(error).toBeNull();
      expect(await billsOf(F.closed, T.guardService)).toHaveLength(1);
    });
  });
});
