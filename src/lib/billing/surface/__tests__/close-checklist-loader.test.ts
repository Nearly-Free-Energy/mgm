/**
 * The `billing.close-checklist` loader: exactly the period, the microgrid,
 * the close review and the bills' sources, all through the person's own
 * client and with no capability composed; refusals with fixed copy, never a
 * database message.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { SurfaceRequest } from "@/lib/gui/surface";

const composeBilling = vi.fn();
vi.mock("@/lib/billing/compose", () => ({ composeBilling: (...args: unknown[]) => composeBilling(...args) }));

import { parseCloseReview } from "../../close";
import { CLOSE_CHECKLIST_REFUSALS, loadCloseChecklist } from "../close-checklist";
import { buildCloseChecklistModel } from "../close-checklist-model";

const ORG = "e7e00000-0000-4000-8000-000000000001";
const MG = "e7e00000-0000-4000-8000-0000000000a1";
const PERIOD = "e7e00000-0000-4000-8000-0000000000b1";
const SECRET = "permission denied for function fn_billing_period_close_review";
const fmt = createFmt({ locale: "en-GB" });

const PERIOD_ROW = {
  id: PERIOD,
  microgrid_id: MG,
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  status: "draft",
  closed_at: null,
  timezone: "Africa/Kampala",
  rate_schedule_id: "e7e00000-0000-4000-8000-0000000000e1",
};
const MICROGRID = { id: MG, name: "North site", timezone: "Africa/Kampala" };
const REVIEW = {
  periodId: PERIOD,
  microgridId: MG,
  status: "draft",
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  currency: "UGX",
  billCount: 3,
  totalAmount: 90000,
  usageKwh: 42,
  unbilled: [{ tenantId: "t-4", tenantName: "House 4" }],
  unmetered: [],
  fractionalTotals: [],
  acknowledgements: ["totals_reviewed", "tenants_without_bills"],
  digest: "v1:abc",
};
const BILLS = [
  { id: "e7e00000-0000-4000-8000-0000000000d1", reading_source: "edge" },
  { id: "e7e00000-0000-4000-8000-0000000000d2", reading_source: "edge" },
  { id: "e7e00000-0000-4000-8000-0000000000d3", reading_source: "manual" },
];

type Fixture = {
  period?: unknown;
  microgrid?: unknown;
  review?: () => { data: unknown; error?: { message: string } };
  bills?: { data: unknown; error?: { message: string } };
  periodError?: boolean;
};

function fixture(o: Fixture = {}) {
  return tableClient(
    {
      billing_periods: o.periodError ? { data: null, error: { message: SECRET } } : { data: o.period === undefined ? [PERIOD_ROW] : o.period },
      microgrids: { data: o.microgrid === undefined ? [MICROGRID] : o.microgrid },
      billing_line_items: o.bills ?? { data: BILLS },
    },
    { fn_billing_period_close_review: o.review ?? (() => ({ data: REVIEW })) },
  );
}

const req = (client: SupabaseClient): SurfaceRequest =>
  ({
    supabase: client,
    user: { id: "e7e00000-0000-4000-8fff-000000000001" } as User,
    roles: [managerOf(ORG)],
    organizationId: ORG,
    params: { id: MG, periodId: PERIOD },
    search: new URLSearchParams(),
    fmt,
  }) as unknown as SurfaceRequest;

beforeEach(() => composeBilling.mockReset());

describe("loadCloseChecklist", () => {
  it("reads the period on its microgrid, the microgrid, the close review and the bills' sources, and nothing else", async () => {
    const { client, calls } = fixture();
    const out = await loadCloseChecklist(req(client));
    expect(out.ok).toBe(true);
    expect(calls).toEqual([
      {
        table: "billing_periods",
        ops: [
          ["select", ["id, microgrid_id, start_date, end_date, status, closed_at, timezone, rate_schedule_id"]],
          ["eq", ["id", PERIOD]],
          ["eq", ["microgrid_id", MG]],
          ["maybeSingle", []],
        ],
      },
      { table: "microgrids", ops: [["select", ["id, name, timezone"]], ["eq", ["id", MG]], ["maybeSingle", []]] },
      { table: "rpc:fn_billing_period_close_review", ops: [["rpc", [{ _period_id: PERIOD }]]] },
      {
        table: "billing_line_items",
        ops: [["select", ["id, reading_source", { count: "exact" }]], ["eq", ["billing_period_id", PERIOD]], ["order", ["id"]], ["limit", [1000]]],
      },
    ]);
    expect(composeBilling).not.toHaveBeenCalled();
  });

  it("builds the model from the review and the bills' sources", async () => {
    const out = await loadCloseChecklist(req(fixture().client));
    if (!out.ok) throw new Error(out.message);
    expect(out.model).toEqual(
      buildCloseChecklistModel({
        microgrid: MICROGRID,
        period: PERIOD_ROW,
        review: parseCloseReview(REVIEW)!,
        sources: { edge: 2, manual: 1 },
        fmt,
      }),
    );
  });

  it.each([
    ["a period the person cannot read, or on another microgrid", { period: null }],
    ["a microgrid the person cannot read", { microgrid: null }],
    ["a review the database withholds", { review: () => ({ data: null }) }],
  ])("refuses %s as not found", async (_label, o: Fixture) => {
    expect(await loadCloseChecklist(req(fixture(o).client))).toEqual(CLOSE_CHECKLIST_REFUSALS.notFound);
  });

  it("refuses a period with no pinned tariff, as the period review does", async () => {
    const out = await loadCloseChecklist(req(fixture({ period: [{ ...PERIOD_ROW, rate_schedule_id: null }] }).client));
    expect(out).toEqual(CLOSE_CHECKLIST_REFUSALS.noTariff);
    expect(out).toMatchObject({ status: 409 });
  });

  it.each([
    ["a failed period read", { periodError: true }],
    ["a failed review", { review: () => ({ data: null, error: { message: SECRET } }) }],
    ["a review in another shape", { review: () => ({ data: { ...REVIEW, digest: "" } }) }],
    ["a failed read of the bills", { bills: { data: null, error: { message: SECRET } } }],
  ])("refuses %s as unavailable, with fixed copy", async (_label, o: Fixture) => {
    const out = await loadCloseChecklist(req(fixture(o).client));
    expect(out).toEqual(CLOSE_CHECKLIST_REFUSALS.unavailable);
    expect(JSON.stringify(out)).not.toContain("permission denied");
  });
});
