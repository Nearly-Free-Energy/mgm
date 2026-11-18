/**
 * The `billing.periods` loader: three reads through the person's own client,
 * newest period first and capped at the host's row cap, totals summed per
 * period, refusals with fixed copy, and no capability composed, so the list
 * still loads while billing is off.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import type { SurfaceRequest } from "@/lib/gui/surface";

const composeBilling = vi.fn();
vi.mock("@/lib/billing/compose", () => ({ composeBilling: (...args: unknown[]) => composeBilling(...args) }));

import { loadPeriods, PERIODS_REFUSALS } from "../periods";

const ORG = "e7600000-0000-4000-8000-000000000001";
const MG = "e7600000-0000-4000-8000-0000000000a1";
const P_NOV = "e7600000-0000-4000-8000-0000000000b2";
const P_OCT = "e7600000-0000-4000-8000-0000000000b1";
const SECRET = "permission denied for table billing_line_items";

type Result = { data: unknown; error: unknown };
let tables: Record<string, Result>;
let reads: unknown[][];

function client(): SupabaseClient {
  return {
    from(table: string) {
      reads.push(["from", table]);
      const result = Promise.resolve(tables[table]);
      const chain: Record<string, unknown> = {
        select: (columns: string) => (reads.push(["select", table, columns]), chain),
        eq: (column: string, value: string) => (reads.push(["eq", table, column, value]), chain),
        in: (column: string, values: string[]) => (reads.push(["in", table, column, values]), chain),
        order: (column: string, o: unknown) => (reads.push(["order", table, column, o]), chain),
        limit: (n: number) => (reads.push(["limit", table, n]), chain),
        maybeSingle: () => result,
        then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) => result.then(ok, no),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const request = (): SurfaceRequest => ({
  supabase: client(),
  user: { id: "u1" } as User,
  roles: [],
  organizationId: ORG,
  params: { id: MG },
  search: new URLSearchParams(),
  locale: "en-GB",
  now: new Date("2026-11-18T08:00:00Z"),
  fmt: createFmt({ locale: "en-GB" }),
});

beforeEach(() => {
  composeBilling.mockReset();
  reads = [];
  tables = {
    microgrids: { data: { id: MG, currency: "UGX" }, error: null },
    billing_periods: {
      data: [
        { id: P_NOV, start_date: "2026-11-01", end_date: "2026-11-30", status: "draft" },
        { id: P_OCT, start_date: "2026-10-01", end_date: "2026-10-31", status: "closed" },
      ],
      error: null,
    },
    billing_line_items: {
      data: [
        { billing_period_id: P_OCT, usage_kwh: "100.5", total_amount: "250000" },
        { billing_period_id: P_OCT, usage_kwh: 20, total_amount: 50000 },
      ],
      error: null,
    },
  };
});

describe("loadPeriods", () => {
  it("reads the microgrid, its periods newest first, and their bills, through the person's client", async () => {
    const out = await loadPeriods(request());
    expect(out.ok).toBe(true);
    expect(reads).toEqual([
      ["from", "microgrids"],
      ["select", "microgrids", "id, currency"],
      ["eq", "microgrids", "id", MG],
      ["from", "billing_periods"],
      ["select", "billing_periods", "id, start_date, end_date, status"],
      ["eq", "billing_periods", "microgrid_id", MG],
      ["order", "billing_periods", "start_date", { ascending: false }],
      ["limit", "billing_periods", 500],
      ["from", "billing_line_items"],
      ["select", "billing_line_items", "billing_period_id, usage_kwh, total_amount"],
      ["in", "billing_line_items", "billing_period_id", [P_NOV, P_OCT]],
    ]);
    expect(composeBilling).not.toHaveBeenCalled();
  });

  it("sums each period's bills, and leaves a period with none at 0 kWh and an empty total", async () => {
    const out = await loadPeriods(request());
    if (!out.ok) throw new Error(out.message);
    const [nov, oct] = out.model.body.rows;
    expect([nov.id, oct.id]).toEqual([P_NOV, P_OCT]);
    expect(oct.cells.energy).toMatchObject({ t: "energy", v: 120.5 });
    expect(oct.cells.total).toMatchObject({ t: "money", v: 300000, currency: "UGX", text: "300,000" });
    expect(nov.cells.energy).toMatchObject({ v: 0 });
    expect(nov.cells.total.t).toBe("empty");
    expect(nov.actions.map((a) => a.action)).toEqual(["billing.delete-period"]);
    expect(oct.actions).toEqual([]);
  });

  it("reads no bills for a microgrid with no periods, and shows the empty state", async () => {
    tables.billing_periods = { data: [], error: null };
    const out = await loadPeriods(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.rows).toEqual([]);
    expect(out.model.body.empty.action).toEqual({ action: "billing.create-period", params: { microgrid_id: MG } });
    expect(reads.filter((r) => r[0] === "from").map((r) => r[1])).toEqual(["microgrids", "billing_periods"]);
  });

  it("names the microgrid's currency in the total's header", async () => {
    tables.microgrids = { data: { id: MG, currency: "KES" }, error: null };
    const out = await loadPeriods(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.columns.find((c) => c.key === "total")!.label).toBe("Total (KES)");
  });

  it("refuses a microgrid row-level security hides, and reads nothing else", async () => {
    tables.microgrids = { data: null, error: null };
    expect(await loadPeriods(request())).toEqual(PERIODS_REFUSALS.notFound);
    expect(reads.filter((r) => r[0] === "from").map((r) => r[1])).toEqual(["microgrids"]);
  });

  it.each(["microgrids", "billing_periods", "billing_line_items"])(
    "refuses with fixed copy when %s cannot be read, rather than show wrong totals",
    async (table) => {
      tables[table] = { data: null, error: { message: SECRET, code: "42501" } };
      const out = await loadPeriods(request());
      expect(out).toEqual(PERIODS_REFUSALS.unavailable);
      expect(JSON.stringify(out)).not.toContain(SECRET);
    },
  );
});
