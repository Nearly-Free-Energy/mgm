/**
 * The `billing.period-review` loader: reads through the person's own client,
 * the period's pinned tariff, every bill in pages, the tenants with their
 * primary meter, and the actors' names; refusals with fixed copy rather
 * than a partial period; and no capability composed, so the view still
 * loads while billing is off.
 *
 * The client here is local rather than host-fakes' tableClient, which
 * ignores range() and gives no count, so paging could not be shown with it.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf, superAdmin } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { SurfaceRequest } from "@/lib/gui/surface";
import type { UserRoleRecord } from "@/lib/types/domain";

const composeBilling = vi.fn();
vi.mock("@/lib/billing/compose", () => ({ composeBilling: (...args: unknown[]) => composeBilling(...args) }));

import { loadPeriodReview, PERIOD_REVIEW_REFUSALS } from "../period-review";

const ORG = "e7600000-0000-4000-8000-000000000001";
const MG = "e7600000-0000-4000-8000-0000000000a1";
const PERIOD = "e7600000-0000-4000-8000-0000000000b1";
const SCHEDULE = "e7600000-0000-4000-8000-0000000000c1";
const T1 = "e7600000-0000-4000-8000-0000000000d1";
const T2 = "e7600000-0000-4000-8000-0000000000d2";
const T3 = "e7600000-0000-4000-8000-0000000000d3";
const USER_1 = "e7600000-0000-4000-8000-0000000000f1";
const SECRET = "permission denied for table billing_line_items";

type Result = { data: unknown; error: unknown };
let tables: Record<string, Result>;
let rpcResult: Result;
let reads: unknown[][];

function client(): SupabaseClient {
  return {
    from(table: string) {
      reads.push(["from", table]);
      let result = Promise.resolve(tables[table]);
      const chain: Record<string, unknown> = {
        select: (columns: string, o?: unknown) => (reads.push(o === undefined ? ["select", table, columns] : ["select", table, columns, o]), chain),
        // A page of the table's rows, with the exact count, as PostgREST answers { count: "exact" }.
        range: (from: number, to: number) => {
          reads.push(["range", table, from, to]);
          const t = tables[table];
          const rows = Array.isArray(t.data) ? t.data : [];
          result = Promise.resolve(t.error ? t : { data: rows.slice(from, to + 1), error: null, count: rows.length });
          return chain;
        },
        eq: (column: string, value: string) => (reads.push(["eq", table, column, value]), chain),
        in: (column: string, values: string[]) => (reads.push(["in", table, column, values]), chain),
        order: (column: string) => (reads.push(["order", table, column]), chain),
        maybeSingle: () => result.then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
        then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) => result.then(ok, no),
      };
      return chain;
    },
    rpc(name: string, args: unknown) {
      reads.push(["rpc", name, args]);
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
}

const request = (roles: UserRoleRecord[] = [managerOf(ORG)]): SurfaceRequest => ({
  supabase: client(),
  user: { id: "u1" } as User,
  roles,
  organizationId: ORG,
  params: { id: MG, periodId: PERIOD },
  search: new URLSearchParams(),
  locale: "en-GB",
  now: new Date("2026-11-18T08:00:00Z"),
  fmt: createFmt({ locale: "en-GB" }),
});

const link = (o: { from?: string; to?: string | null; component?: string | null; edge?: string | null } = {}) => ({
  role: "primary_consumption_meter",
  effective_from: o.from ?? "2026-01-01",
  effective_to: o.to ?? null,
  devices: { openems_component_id: o.component === undefined ? "meter1" : o.component, edges: { openems_edge_id: o.edge === undefined ? "edge0" : o.edge } },
});

const bill = (id: string, tenant: string, o: Record<string, unknown> = {}) => ({
  id,
  tenant_id: tenant,
  device_id: null,
  start_kwh: "100.5",
  end_kwh: "150.5",
  usage_kwh: "50",
  tier_breakdown: [{ label: "Lifeline", kwh: 50, amount: 12500 }],
  total_amount: "12500",
  reading_source: "edge",
  payment_status: "unpaid",
  invoice_number: null,
  entered_at: null,
  entered_by_user_id: null,
  ...o,
});

beforeEach(() => {
  composeBilling.mockReset();
  reads = [];
  rpcResult = { data: [{ user_id: USER_1, first_name: "Okello", last_name: "Daniel", email: "okello@example.test" }], error: null };
  tables = {
    billing_periods: {
      data: { id: PERIOD, microgrid_id: MG, start_date: "2026-10-01", end_date: "2026-10-31", status: "draft", timezone: "Africa/Kampala", rate_schedule_id: SCHEDULE },
      error: null,
    },
    microgrids: { data: { id: MG, name: "North", currency: "UGX" }, error: null },
    rate_schedules: { data: { id: SCHEDULE, tiers: [{ label: "Lifeline" }, { label: "Standard" }] }, error: null },
    billing_line_items: {
      data: [
        bill("e7600000-0000-4000-8000-0000000000e1", T1),
        bill("e7600000-0000-4000-8000-0000000000e2", T2, { reading_source: "manual", entered_at: "2026-10-31T12:00:00Z", entered_by_user_id: USER_1 }),
      ],
      error: null,
    },
    tenants: {
      data: [
        { id: T1, display_name: "Akello", tenant_devices: [link()] },
        { id: T2, display_name: "Byaruhanga", tenant_devices: [] },
        { id: T3, display_name: "Kato", tenant_devices: [link({ component: null })] },
      ],
      error: null,
    },
  };
});

describe("loadPeriodReview", () => {
  it("reads through the person's client: the period under its microgrid, the tariff, bills and tenants in pages, and the actors", async () => {
    const out = await loadPeriodReview(request());
    expect(out.ok).toBe(true);
    expect(reads.filter((r) => ["from", "rpc"].includes(r[0] as string)).map((r) => r.slice(0, 2))).toEqual([
      ["from", "billing_periods"],
      ["from", "microgrids"],
      ["from", "rate_schedules"],
      ["from", "billing_line_items"],
      ["from", "tenants"],
      ["rpc", "fn_list_visible_users"],
    ]);
    expect(reads).toEqual(
      expect.arrayContaining([
        ["select", "billing_periods", "id, microgrid_id, start_date, end_date, status, timezone, rate_schedule_id"],
        ["eq", "billing_periods", "id", PERIOD],
        ["eq", "billing_periods", "microgrid_id", MG],
        ["select", "microgrids", "id, name, currency"],
        ["eq", "rate_schedules", "id", SCHEDULE],
        ["eq", "rate_schedules", "microgrid_id", MG],
        [
          "select",
          "billing_line_items",
          "id, tenant_id, device_id, start_kwh, end_kwh, usage_kwh, tier_breakdown, total_amount, reading_source, payment_status, invoice_number, entered_at, entered_by_user_id",
          { count: "exact" },
        ],
        ["eq", "billing_line_items", "billing_period_id", PERIOD],
        ["range", "billing_line_items", 0, 999],
        ["eq", "tenants", "microgrid_id", MG],
        ["eq", "tenants", "tenant_devices.role", "primary_consumption_meter"],
        ["order", "tenants", "display_name"],
        ["range", "tenants", 0, 999],
        ["rpc", "fn_list_visible_users", { _target_user_ids: [USER_1] }],
      ]),
    );
    expect(composeBilling).not.toHaveBeenCalled();
  });

  it("builds rows from the pinned tariff's tiers, with numbers from NUMERIC columns", async () => {
    const out = await loadPeriodReview(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.columns.filter((c) => c.key.startsWith("tier.")).map((c) => c.label)).toEqual([
      "Lifeline kWh",
      "Lifeline (UGX)",
      "Standard kWh",
      "Standard (UGX)",
    ]);
    expect(out.model.body.rows.map((r) => r.cells.tenant.text)).toEqual(["Akello", "Byaruhanga"]);
    expect(out.model.body.rows[0].cells.begin).toMatchObject({ v: 100.5 });
    expect(out.model.body.totals?.total).toMatchObject({ v: 25000 });
    // The prefill holds a number, so it parses against RegenerateBillBody.
    const manualEntry = out.model.body.rows[0].actions.find((a) => a.label === "Switch to manual entry");
    expect(manualEntry?.prefill).toEqual({ readings: "manual", start_kwh: 100.5 });
  });

  it("names who entered a manual reading, and says 'a user' when the names cannot be read", async () => {
    let out = await loadPeriodReview(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.rows[1].cells.entered.text).toMatch(/^Okello Daniel · /);
    rpcResult = { data: [{ user_id: USER_1, first_name: null, last_name: null, email: "okello@example.test" }], error: null };
    out = await loadPeriodReview(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.rows[1].cells.entered.text).toMatch(/^okello@example\.test · /);
    rpcResult = { data: null, error: { message: SECRET } };
    out = await loadPeriodReview(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.rows[1].cells.entered.text).toMatch(/^a user · /);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("asks for no names when no bill was entered by hand", async () => {
    tables.billing_line_items.data = [bill("e7600000-0000-4000-8000-0000000000e1", T1)];
    await loadPeriodReview(request());
    expect(reads.some((r) => r[0] === "rpc")).toBe(false);
  });

  it("decides edge availability from the primary meter, and the usage offer from an assignment in the period", async () => {
    const unmetered = { id: T1, display_name: "Akello" };
    const offers = async (tenantDevices: unknown[]) => {
      tables.tenants.data = [{ ...unmetered, tenant_devices: tenantDevices }];
      tables.billing_line_items.data = [bill("e7600000-0000-4000-8000-0000000000e1", T1)];
      const out = await loadPeriodReview(request());
      if (!out.ok) throw new Error(out.message);
      const labels = out.model.body.rows[0].actions.map((a) => a.label ?? a.action);
      return { edge: labels.includes("Regenerate from edge data"), usage: labels.includes("billing.record-usage") };
    };
    expect(await offers([])).toEqual({ edge: false, usage: true });
    expect(await offers([link()])).toEqual({ edge: true, usage: false });
    expect(await offers([link({ component: null })])).toEqual({ edge: false, usage: false });
    expect(await offers([link({ edge: null })])).toEqual({ edge: false, usage: false });
    // Assignments that ended before the period, or start after it, do not block a correction.
    expect(await offers([link({ from: "2026-01-01", to: "2026-10-01" })]).then((o) => o.usage)).toBe(true);
    expect(await offers([link({ from: "2026-11-01" })]).then((o) => o.usage)).toBe(true);
    expect(await offers([link({ from: "2026-10-31" })]).then((o) => o.usage)).toBe(false);
  });

  it.each([
    ["an organization manager", [managerOf(ORG)], false],
    ["a super admin", [superAdmin()], true],
  ])("offers marking failed and refunded by role: %s", async (_label, roles, offered) => {
    tables.billing_line_items.data = [
      bill("e7600000-0000-4000-8000-0000000000e1", T1, { payment_status: "paid", }),
      bill("e7600000-0000-4000-8000-0000000000e2", T2, { payment_status: "link_generated" }),
    ];
    const out = await loadPeriodReview(request(roles));
    if (!out.ok) throw new Error(out.message);
    const ids = out.model.body.rows.flatMap((r) => r.actions.map((a) => a.action));
    expect(ids.includes("billing.mark-refunded")).toBe(offered);
    expect(ids.includes("billing.mark-failed")).toBe(offered);
    expect(ids).toEqual(expect.arrayContaining(["billing.mark-unpaid", "billing.cancel-payment-link", "billing.mark-paid"]));
  });

  it("reads every bill in pages, past PostgREST's row cap", async () => {
    tables.billing_line_items.data = Array.from({ length: 2500 }, (_, i) =>
      bill(`e7600000-0000-4000-8000-${String(i).padStart(12, "0")}`, i === 0 ? T1 : `e7600000-0000-4000-8001-${String(i).padStart(12, "0")}`, {
        usage_kwh: 1,
        total_amount: 10,
      }),
    );
    const out = await loadPeriodReview(request());
    expect(reads.filter((r) => r[0] === "range" && r[1] === "billing_line_items")).toEqual([
      ["range", "billing_line_items", 0, 999],
      ["range", "billing_line_items", 1000, 1999],
      ["range", "billing_line_items", 2000, 2999],
    ]);
    if (!out.ok) throw new Error(out.message);
    // One readable tenant's row; the totals count every bill.
    expect(out.model.body.rows).toHaveLength(1);
    expect(out.model.body.totals?.usage).toMatchObject({ v: 2500 });
    expect(out.model.body.totals?.total).toMatchObject({ v: 25000 });
  });

  it("refuses a period under another microgrid, or one row-level security hides", async () => {
    tables.billing_periods = { data: null, error: null };
    expect(await loadPeriodReview(request())).toEqual(PERIOD_REVIEW_REFUSALS.notFound);
    tables.billing_periods = { data: { id: PERIOD }, error: null };
    tables.microgrids = { data: null, error: null };
    expect(await loadPeriodReview(request())).toEqual(PERIOD_REVIEW_REFUSALS.notFound);
  });

  it("refuses a period with no pinned tariff with the legacy page's copy, reading no bills", async () => {
    (tables.billing_periods.data as Record<string, unknown>).rate_schedule_id = null;
    expect(await loadPeriodReview(request())).toEqual(PERIOD_REVIEW_REFUSALS.noTariff);
    expect(reads.filter((r) => r[0] === "from").map((r) => r[1])).toEqual(["billing_periods", "microgrids"]);
    (tables.billing_periods.data as Record<string, unknown>).rate_schedule_id = SCHEDULE;
    tables.rate_schedules = { data: null, error: null };
    expect(await loadPeriodReview(request())).toEqual(PERIOD_REVIEW_REFUSALS.noTariff);
  });

  it("refuses rather than show part of a period: more than 20 tiers, or more than 500 rows", async () => {
    tables.rate_schedules.data = { id: SCHEDULE, tiers: Array.from({ length: 21 }, (_, i) => ({ label: `T${i}` })) };
    expect(await loadPeriodReview(request())).toEqual(PERIOD_REVIEW_REFUSALS.tooLarge);
    tables.rate_schedules.data = { id: SCHEDULE, tiers: Array.from({ length: 20 }, (_, i) => ({ label: `T${i}` })) };
    expect((await loadPeriodReview(request())).ok).toBe(true);

    const ids = Array.from({ length: 501 }, (_, i) => `e7600000-0000-4000-8001-${String(i).padStart(12, "0")}`);
    tables.tenants.data = ids.map((id, i) => ({ id, display_name: `Unit ${i}`, tenant_devices: [] }));
    tables.billing_line_items.data = ids.map((id, i) => bill(`e7600000-0000-4000-8002-${String(i).padStart(12, "0")}`, id));
    expect(await loadPeriodReview(request())).toEqual(PERIOD_REVIEW_REFUSALS.tooLarge);
    tables.billing_line_items.data = ids.slice(0, 500).map((id, i) => bill(`e7600000-0000-4000-8002-${String(i).padStart(12, "0")}`, id));
    const out = await loadPeriodReview(request());
    expect(out.ok && out.model.body.rows.length).toBe(500);
  });

  it.each(["billing_periods", "microgrids", "rate_schedules", "billing_line_items", "tenants"])(
    "refuses with fixed copy when %s cannot be read, rather than show part of the period",
    async (table) => {
      tables[table] = { data: null, error: { message: SECRET, code: "42501" } };
      const out = await loadPeriodReview(request());
      expect(out).toEqual(PERIOD_REVIEW_REFUSALS.unavailable);
      expect(JSON.stringify(out)).not.toContain(SECRET);
    },
  );
});
