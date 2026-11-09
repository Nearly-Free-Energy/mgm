/**
 * Billing list page — how it loads.
 *
 * The periods, their line-item totals and the currency start together with
 * the access check and the breadcrumb instead of after them, and a failed
 * period read still shows its banner without reading line items.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const MICROGRID_ID = "770e8400-e29b-41d4-a716-446655442000";

type Reply = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  replies: {} as Record<string, Reply>,
  tables: [] as string[],
  lineItemPeriodIds: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      db.tables.push(table);
      const reply = () => Promise.resolve(db.replies[table] ?? { data: [], error: null });
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        in: (_column: string, values: unknown) => {
          db.lineItemPeriodIds = values;
          return builder;
        },
        returns: () => builder,
        single: () => reply(),
        then: (resolve: (value: Reply) => unknown, reject?: (reason: unknown) => unknown) =>
          reply().then(resolve, reject),
      };
      return builder;
    },
  }),
}));

const hierarchy = vi.hoisted(() => ({ getHierarchyLevels: vi.fn() }));
vi.mock("@/lib/hierarchy", () => hierarchy);
vi.mock("@/components/ui/hierarchy-nav", () => ({ HierarchyNav: () => null }));

const access = vi.hoisted(() => ({ requestUserCanAccessMicrogrid: vi.fn() }));
vi.mock("@/lib/auth/request-access", () => access);

vi.mock("@/components/BillingPeriodList", () => ({
  BillingPeriodList: (props: Record<string, unknown>) =>
    React.createElement("pre", { "data-testid": "list" }, JSON.stringify(props)),
}));

import BillingPage from "../page";

const render = async () =>
  renderToStaticMarkup(
    (await BillingPage({ params: Promise.resolve({ id: MICROGRID_ID }) })) as React.ReactElement
  );

function listProps(html: string) {
  const m = html.match(/<pre data-testid="list">([^<]*)<\/pre>/);
  if (!m) throw new Error("list not rendered");
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

beforeEach(() => {
  vi.clearAllMocks();
  db.tables = [];
  db.lineItemPeriodIds = null;
  db.replies = {
    billing_periods: { data: [{ id: "p-2" }, { id: "p-1" }], error: null },
    billing_line_items: {
      data: [
        { billing_period_id: "p-1", usage_kwh: 10, total_amount: 5000 },
        { billing_period_id: "p-1", usage_kwh: 5, total_amount: 2500 },
      ],
      error: null,
    },
    microgrids: { data: { currency: "KES" }, error: null },
  };
  hierarchy.getHierarchyLevels.mockResolvedValue([]);
  access.requestUserCanAccessMicrogrid.mockResolvedValue(true);
});

describe("BillingPage", () => {
  it("loads the periods and their totals without waiting for the breadcrumb or the access check", async () => {
    let releaseBreadcrumb: (levels: never[]) => void = () => {};
    hierarchy.getHierarchyLevels.mockReturnValue(new Promise((resolve) => { releaseBreadcrumb = resolve; }));
    let releaseAccess: (value: boolean) => void = () => {};
    access.requestUserCanAccessMicrogrid.mockReturnValue(new Promise((resolve) => { releaseAccess = resolve; }));

    const page = BillingPage({ params: Promise.resolve({ id: MICROGRID_ID }) });
    await vi.waitFor(() =>
      expect([...db.tables].sort()).toEqual(["billing_line_items", "billing_periods", "microgrids"])
    );
    releaseBreadcrumb([]);
    releaseAccess(false);
    expect(listProps(renderToStaticMarkup((await page) as React.ReactElement)).canManage).toBe(false);
  });

  it("sums line items per period and passes the currency", async () => {
    const props = listProps(await render());
    expect(db.lineItemPeriodIds).toEqual(["p-2", "p-1"]);
    expect(props.summaries).toEqual({ "p-1": { totalKwh: 15, totalAmount: 7500 } });
    expect(props.currency).toBe("KES");
    expect(props.canManage).toBe(true);
  });

  it("skips the line-item read when there are no periods", async () => {
    db.replies.billing_periods = { data: [], error: null };
    const props = listProps(await render());
    expect(db.tables).not.toContain("billing_line_items");
    expect(props.summaries).toEqual({});
  });

  it("shows the period error without reading line items", async () => {
    db.replies.billing_periods = { data: null, error: { message: "periods failed" } };
    const html = await render();
    expect(html).toContain("Error loading billing periods: periods failed");
    expect(db.tables).not.toContain("billing_line_items");
  });
});
