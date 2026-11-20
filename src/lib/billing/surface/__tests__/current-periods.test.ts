/**
 * The `billing.current-periods` view, Today's billing tile: each of the
 * organization's microgrids by name with its newest period, read through
 * the person's own client and filtered to the organization explicitly (a
 * super admin's row-level security shows every organization); each row
 * leads to that period's review, or to the microgrid's periods when it has
 * none; no entity, tenant or amount; a failed read refused with fixed copy.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { superAdmin, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import type { SurfaceRequest, ViewDef } from "@/lib/gui/surface";
import { BILLING_SURFACE } from "../../surface";
import { loadCurrentPeriods, CURRENT_PERIODS_UNAVAILABLE } from "../current-periods";
import { CURRENT_PERIODS_EXAMPLES } from "../current-periods-examples";
import { buildCurrentPeriodsModel, CURRENT_PERIODS_VIEW, MAX_CURRENT_PERIODS } from "../current-periods-model";

const ORG = "e7f20000-0000-4000-8000-000000000001";
const MG = "e7f20000-0000-4000-8000-0000000000a1";
const MG2 = "e7f20000-0000-4000-8000-0000000000a2";
const PERIOD = "e7f20000-0000-4000-8000-0000000000b1";
const SECRET = "permission denied for table billing_periods";
const fmt = createFmt({ locale: "en-GB" });

const req = (client: SupabaseClient): SurfaceRequest =>
  ({
    supabase: client,
    user: { id: "e7f20000-0000-4000-8fff-000000000001" } as User,
    roles: [superAdmin()],
    organizationId: ORG,
    params: {},
    search: new URLSearchParams(),
    locale: "en-GB",
    now: new Date("2026-11-20T09:00:00Z"),
    fmt,
  }) as unknown as SurfaceRequest;

const def = BILLING_SURFACE.views!.find((v) => v.id === CURRENT_PERIODS_VIEW) as ViewDef;

describe("loadCurrentPeriods", () => {
  it("reads the organization's microgrids by name with each one's newest period, and nothing else", async () => {
    const { client, calls } = tableClient({
      microgrids: {
        data: [
          {
            id: MG,
            name: "North site",
            communities: { org_id: ORG },
            billing_periods: [{ id: PERIOD, start_date: "2026-11-01", end_date: "2026-11-30", status: "draft", billing_line_items: [{ count: 42 }] }],
          },
          { id: MG2, name: "South site", communities: { org_id: ORG }, billing_periods: [] },
        ],
      },
    });
    const out = await loadCurrentPeriods(req(client));
    expect(calls).toEqual([
      {
        table: "microgrids",
        ops: [
          ["select", ["id, name, communities!inner(org_id), billing_periods(id, start_date, end_date, status, billing_line_items(count))"]],
          ["eq", ["communities.org_id", ORG]],
          ["order", ["name", { ascending: true }]],
          ["order", ["id", { ascending: true }]],
          ["order", ["start_date", { referencedTable: "billing_periods", ascending: false }]],
          ["order", ["id", { referencedTable: "billing_periods", ascending: false }]],
          ["limit", [1, { referencedTable: "billing_periods" }]],
          ["limit", [MAX_CURRENT_PERIODS + 1]],
        ],
      },
    ]);
    expect(out).toEqual({
      ok: true,
      model: buildCurrentPeriodsModel(fmt, [
        { microgridId: MG, microgridName: "North site", period: { id: PERIOD, start_date: "2026-11-01", end_date: "2026-11-30", status: "draft", bills: 42 } },
        { microgridId: MG2, microgridName: "South site", period: null },
      ]),
    });
  });

  it("refuses a failed read with fixed copy, never the database's message", async () => {
    const { client } = tableClient({ microgrids: { data: null, error: { message: SECRET } } });
    const out = await loadCurrentPeriods(req(client));
    expect(out).toEqual(CURRENT_PERIODS_UNAVAILABLE);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe("buildCurrentPeriodsModel", () => {
  it("leads each microgrid to its newest period's review, or to its periods when it has none", () => {
    const model = buildCurrentPeriodsModel(fmt, [
      { microgridId: MG, microgridName: "North site", period: { id: PERIOD, start_date: "2026-10-01", end_date: "2026-10-31", status: "closed", bills: 17 } },
      { microgridId: MG2, microgridName: "South site", period: null },
    ]);
    expect(model.title).toBe("Current billing periods");
    expect(model.body.rows.map((r) => [r.href, r.cells.microgrid.text, r.cells.period.text, r.cells.status, r.cells.bills.text])).toEqual([
      [`/microgrids/${MG}/billing/${PERIOD}`, "North site", `${fmt.date("2026-10-01").text} – ${fmt.date("2026-10-31").text}`, fmt.status("billingPeriod", "closed"), "17"],
      [`/microgrids/${MG2}/billing`, "South site", fmt.empty().text, fmt.text("No periods yet"), fmt.empty().text],
    ]);
    for (const row of model.body.rows) expect(row.entity).toBeUndefined();
    expect(model.notice).toBeUndefined();
  });

  it("shows at most the cap, and says so when there were more", () => {
    const many = Array.from({ length: MAX_CURRENT_PERIODS + 1 }, (_, i) => ({ microgridId: `${MG}${i}`, microgridName: `Site ${i}`, period: null }));
    const model = buildCurrentPeriodsModel(fmt, many);
    expect(model.body.rows).toHaveLength(MAX_CURRENT_PERIODS);
    expect(model.notice).toEqual({ tone: "info", text: `The first ${MAX_CURRENT_PERIODS} microgrids are shown.` });
  });

  it("passes the host's strict parse, as the loader returns it", () => {
    expect(strictParseModel(def, buildCurrentPeriodsModel(fmt, [{ microgridId: MG, microgridName: "N", period: null }])).ok).toBe(true);
    expect(strictParseModel(def, buildCurrentPeriodsModel(fmt, [])).ok).toBe(true);
  });
});

describe("the billing.current-periods view", () => {
  it("is a tile on Today, served on its own page at /billing, read by no assistant", () => {
    expect(def).toMatchObject({ path: "/billing", params: {}, cost: "db", attach: { to: { view: "org.today" }, hint: "tile" } });
    expect(def.agent).toBeUndefined();
    expect(def.attach?.whilePluginOff).toBeUndefined();
    expect(CURRENT_PERIODS_EXAMPLES.length).toBeGreaterThan(0);
  });
});
