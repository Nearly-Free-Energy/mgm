/**
 * The `billing.periods` loader: three reads through the person's own client,
 * newest period first and capped at the host's row cap, totals summed per
 * period, the new period form starting at the previous month in the
 * microgrid's zone, the time zone nudge the microgrid layout shows, refusals
 * with fixed copy, and no capability composed, so the list still loads while
 * billing is off.
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
      let result = Promise.resolve(tables[table]);
      let after: string | null = null;
      const chain: Record<string, unknown> = {
        select: (columns: string, o?: unknown) => (reads.push(o === undefined ? ["select", table, columns] : ["select", table, columns, o]), chain),
        eq: (column: string, value: string) => (reads.push(["eq", table, column, value]), chain),
        in: (column: string, values: string[]) => (reads.push(["in", table, column, values]), chain),
        gt: (column: string, value: string) => (reads.push(["gt", table, column, value]), (after = value), chain),
        order: (column: string, o: unknown) => (reads.push(["order", table, column, o]), chain),
        // A page by id after `gt`, with the exact count of what is left, as PostgREST answers { count: "exact" }.
        limit: (n: number) => {
          reads.push(["limit", table, n]);
          const t = tables[table];
          if (table !== "billing_line_items" || t.error || !Array.isArray(t.data)) return chain;
          const left = (t.data as { id: string }[]).filter((r) => after === null || r.id > after).sort((a, b) => (a.id < b.id ? -1 : 1));
          result = Promise.resolve({ data: left.slice(0, n), error: null, count: left.length });
          return chain;
        },
        maybeSingle: () => result,
        then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) => result.then(ok, no),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

const request = (now = new Date("2026-11-18T08:00:00Z")): SurfaceRequest => ({
  supabase: client(),
  user: { id: "u1" } as User,
  roles: [],
  organizationId: ORG,
  params: { id: MG },
  search: new URLSearchParams(),
  locale: "en-GB",
  now,
  fmt: createFmt({ locale: "en-GB" }),
});

/** The microgrid row as the loader reads it: Kampala, set, so no nudge. */
const microgrid = (o: Record<string, unknown> = {}) => ({
  data: { id: MG, currency: "UGX", timezone: "Africa/Kampala", address_country: "Uganda", lat: 0.35, lng: 32.6, ...o },
  error: null,
});

beforeEach(() => {
  composeBilling.mockReset();
  reads = [];
  tables = {
    microgrids: microgrid(),
    billing_periods: {
      data: [
        { id: P_NOV, start_date: "2026-11-01", end_date: "2026-11-30", status: "draft" },
        { id: P_OCT, start_date: "2026-10-01", end_date: "2026-10-31", status: "closed" },
      ],
      error: null,
    },
    billing_line_items: {
      data: [
        { id: "b1", billing_period_id: P_OCT, usage_kwh: "100.5", total_amount: "250000" },
        { id: "b2", billing_period_id: P_OCT, usage_kwh: 20, total_amount: 50000 },
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
      ["select", "microgrids", "id, currency, timezone, address_country, lat, lng"],
      ["eq", "microgrids", "id", MG],
      ["from", "billing_periods"],
      ["select", "billing_periods", "id, start_date, end_date, status"],
      ["eq", "billing_periods", "microgrid_id", MG],
      ["order", "billing_periods", "start_date", { ascending: false }],
      ["limit", "billing_periods", 500],
      ["from", "billing_line_items"],
      ["select", "billing_line_items", "id, billing_period_id, usage_kwh, total_amount, billing_periods!inner(microgrid_id)", { count: "exact" }],
      ["eq", "billing_line_items", "billing_periods.microgrid_id", MG],
      ["order", "billing_line_items", "id", undefined],
      ["limit", "billing_line_items", 1000],
    ]);
    expect(composeBilling).not.toHaveBeenCalled();
  });

  it("reads every bill in pages, past PostgREST's row cap, before summing", async () => {
    tables.billing_line_items = {
      data: Array.from({ length: 2500 }, (_, i) => ({ id: `b${String(i).padStart(5, "0")}`, billing_period_id: P_OCT, usage_kwh: 1, total_amount: 10 })),
      error: null,
    };
    const out = await loadPeriods(request());
    // Each page starts after the last id of the one before: none skipped or repeated.
    expect(reads.filter((r) => r[0] === "gt")).toEqual([
      ["gt", "billing_line_items", "id", "b00999"],
      ["gt", "billing_line_items", "id", "b01999"],
    ]);
    if (!out.ok) throw new Error("refused");
    const october = out.model.body.rows.find((r) => r.id === P_OCT)!;
    expect(october.cells.energy).toMatchObject({ v: 2500 });
    expect(october.cells.total).toMatchObject({ v: 25000 });
  });

  it("sums money in minor units, so many fractional drafts add up exactly", async () => {
    tables.billing_line_items = {
      data: Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, billing_period_id: P_OCT, usage_kwh: 1, total_amount: 0.1 })),
      error: null,
    };
    tables.microgrids = microgrid({ currency: "USD" });
    const out = await loadPeriods(request());
    if (!out.ok) throw new Error("refused");
    const october = out.model.body.rows.find((r) => r.id === P_OCT)!;
    // 10 × 0.10 is exactly 1.00 USD, 100 cents, not 0.9999999999999999.
    expect(october.cells.total).toMatchObject({ v: 100 });
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
    expect(out.model.body.empty.action).toEqual({
      action: "billing.create-period",
      params: { microgrid_id: MG },
      prefill: { start_date: "2026-10-01", end_date: "2026-10-31" },
    });
    expect(reads.filter((r) => r[0] === "from").map((r) => r[1])).toEqual(["microgrids", "billing_periods"]);
  });

  it("names the microgrid's currency in the total's header", async () => {
    tables.microgrids = microgrid({ currency: "KES" });
    const out = await loadPeriods(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.body.columns.find((c) => c.key === "total")!.label).toBe("Total (KES)");
  });

  it.each([
    // 00:30 on 1 November in Kampala is still 31 October in UTC.
    ["Africa/Kampala", "2026-11-01T00:30:00+03:00", { start_date: "2026-10-01", end_date: "2026-10-31" }],
    // 22:00 on 31 October in New York is already 1 November in UTC.
    ["America/New_York", "2026-10-31T22:00:00-04:00", { start_date: "2026-09-01", end_date: "2026-09-30" }],
    // Just after midnight UTC on 1 November: a UTC microgrid's month has turned.
    ["UTC", "2026-11-01T00:30:00Z", { start_date: "2026-10-01", end_date: "2026-10-31" }],
    // January rolls back to December of the previous year.
    ["Africa/Kampala", "2027-01-01T00:30:00+03:00", { start_date: "2026-12-01", end_date: "2026-12-31" }],
  ])("starts the new period form at the previous month in the microgrid's zone (%s, %s)", async (timezone, now, prefill) => {
    tables.microgrids = microgrid({ timezone });
    const out = await loadPeriods(request(new Date(now)));
    if (!out.ok) throw new Error(out.message);
    expect(out.model.actions).toEqual([{ action: "billing.create-period", params: { microgrid_id: MG }, prefill }]);
    expect(out.model.body.empty.action).toEqual(out.model.actions[0]);
  });

  it("starts the form in UTC's calendar, not the server's, for a microgrid with no zone", async () => {
    tables.microgrids = microgrid({ timezone: null, address_country: null, lat: null, lng: null });
    const out = await loadPeriods(request(new Date("2026-11-01T00:30:00Z")));
    if (!out.ok) throw new Error(out.message);
    expect(out.model.actions[0].prefill).toEqual({ start_date: "2026-10-01", end_date: "2026-10-31" });
  });

  it("shows the time zone nudge for a microgrid whose address implies another zone while it bills in UTC", async () => {
    tables.microgrids = microgrid({ timezone: "UTC" });
    const out = await loadPeriods(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model.notice).toEqual({
      tone: "warning",
      text: "Billing timezone is still UTC. This microgrid's address is in Uganda (Africa/Kampala (UTC+3)) but its billing timezone is UTC — set it? Billing days currently start and end at midnight UTC.",
    });
    expect(out.model.links).toEqual([{ id: "billing.set-timezone", label: "Set timezone", href: `/microgrids/${MG}/setup/rates` }]);
  });

  it.each([
    ["a zone already set", {}],
    ["a UTC microgrid with no address", { timezone: "UTC", address_country: null, lat: null, lng: null }],
  ])("shows no nudge for %s", async (_name, o) => {
    tables.microgrids = microgrid(o);
    const out = await loadPeriods(request());
    if (!out.ok) throw new Error(out.message);
    expect(out.model).not.toHaveProperty("notice");
    expect(out.model).not.toHaveProperty("links");
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
