// Setup > Rates — server component tests.
//
// The page reads the customer rate schedule, the microgrid, the grid tariff
// versions and the savings settings through the user's RLS client, and hands
// them to TierEditor and GridTariffEditor.
//
// Strategy:
//   - Mock @/lib/supabase/server with a `from` dispatched per table; every
//     chain resolves to that table's { data, error }.
//   - Mock @/lib/auth/access and @/lib/hierarchy.
//   - Fake the clock so "today" in the microgrid's timezone is fixed.
//   - Call RatesPage() directly and inspect the element tree and its markup.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { fromMock, canAccessMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  canAccessMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: fromMock }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: canAccessMock,
}));

vi.mock("@/lib/hierarchy", () => ({
  getHierarchyLevels: vi.fn().mockResolvedValue([]),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

// ── Import (after mocks) ──────────────────────────────────────────────────────

import RatesPage from "../page";
import { TierEditor } from "@/components/TierEditor";
import { GridTariffEditor } from "@/components/GridTariffEditor";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MICROGRID = { id: "mg-1", name: "Example", currency: "UGX", timezone: "Africa/Kampala" };

const TARIFF = {
  id: "t-1",
  microgrid_id: "mg-1",
  effective_from: "2026-01-01",
  bands: [
    { from_hour: 0, to_hour: 6, rate: 400 },
    { from_hour: 6, to_hour: 18, rate: 550 },
    { from_hour: 18, to_hour: 24, rate: 650 },
  ],
  created_at: "2026-01-01T00:00:00Z",
};

const SETTINGS = {
  microgrid_id: "mg-1",
  solar_savings_from: "2026-10-01",
  arbitrage_from: null,
  // PostgREST may hand numeric back as a string.
  round_trip_efficiency: "0.900",
  updated_at: "2026-10-01T00:00:00Z",
};

type Result = { data: unknown; error: { message: string } | null };

function query(result: Result) {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(result);
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return () => chain;
      },
    }
  );
  return chain;
}

function stubTables(overrides: Partial<Record<string, Result>> = {}) {
  const tables: Record<string, Result> = {
    rate_schedules: { data: null, error: null },
    microgrids: { data: MICROGRID, error: null },
    grid_tariffs: { data: [TARIFF], error: null },
    microgrid_savings_settings: { data: SETTINGS, error: null },
    ...overrides,
  };
  fromMock.mockImplementation((table: string) => {
    const result = tables[table];
    if (!result) throw new Error(`unexpected table ${table}`);
    return query(result);
  });
}

type AnyElement = React.ReactElement<Record<string, unknown>>;

function findAll(node: React.ReactNode, type: unknown): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, type));
  if (!React.isValidElement(node)) return [];
  const element = node as AnyElement;
  const here = element.type === type ? [element] : [];
  return [...here, ...findAll(element.props.children as React.ReactNode, type)];
}

async function callPage(): Promise<React.ReactElement> {
  return (await RatesPage({ params: Promise.resolve({ id: "mg-1" }) })) as React.ReactElement;
}

// 22:30 UTC on 6 Nov is 01:30 on 7 Nov in Kampala.
const NOW = new Date("2026-11-06T22:30:00Z");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RatesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    canAccessMock.mockResolvedValue(true);
    stubTables();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the grid tariff and the savings settings through the user's client", async () => {
    await callPage();

    expect(fromMock).toHaveBeenCalledWith("grid_tariffs");
    expect(fromMock).toHaveBeenCalledWith("microgrid_savings_settings");
  });

  it("keeps the customer tariff editor first", async () => {
    const tree = await callPage();
    const tier = findAll(tree, TierEditor);
    expect(tier).toHaveLength(1);
    expect(tier[0].props).toMatchObject({ microgridId: "mg-1", currency: "UGX", canManage: true });
  });

  it("hands GridTariffEditor the versions, the settings, today in the microgrid's timezone and canManage", async () => {
    const tree = await callPage();
    const [editor] = findAll(tree, GridTariffEditor);

    expect(editor.props).toEqual({
      microgridId: "mg-1",
      currency: "UGX",
      tariffs: [TARIFF],
      settings: { ...SETTINGS, round_trip_efficiency: 0.9 },
      today: "2026-11-07",
      canManage: true,
    });
  });

  it("passes canManage false through", async () => {
    canAccessMock.mockResolvedValue(false);
    const tree = await callPage();
    expect(findAll(tree, GridTariffEditor)[0].props.canManage).toBe(false);
  });

  it("passes null settings and no versions when there are none", async () => {
    stubTables({
      grid_tariffs: { data: null, error: null },
      microgrid_savings_settings: { data: null, error: null },
    });
    const tree = await callPage();
    const [editor] = findAll(tree, GridTariffEditor);

    expect(editor.props.tariffs).toEqual([]);
    expect(editor.props.settings).toBeNull();
  });

  it("uses UTC for today when the stored timezone is not supported", async () => {
    stubTables({ microgrids: { data: { ...MICROGRID, timezone: "Mars/Olympus" }, error: null } });
    const tree = await callPage();
    expect(findAll(tree, GridTariffEditor)[0].props.today).toBe("2026-11-06");
  });

  it("renders the grid tariff section under its heading", async () => {
    const html = renderToStaticMarkup(await callPage());

    expect(html).toContain("Grid tariff (what the microgrid pays the utility)");
    expect(html.indexOf("Rate Schedule")).toBeLessThan(
      html.indexOf("Grid tariff (what the microgrid pays the utility)")
    );
    expect(html).toContain("Tariff versions");
    expect(html).toContain("Savings settings");
  });

  it("shows an error in place of the editor when the grid tariff read fails", async () => {
    stubTables({ grid_tariffs: { data: null, error: { message: "permission denied" } } });
    const tree = await callPage();
    const html = renderToStaticMarkup(tree);

    expect(findAll(tree, GridTariffEditor)).toHaveLength(0);
    expect(html).toContain("Error loading the grid tariff: permission denied");
    // The customer tariff editor still renders.
    expect(findAll(tree, TierEditor)).toHaveLength(1);
  });

  it("shows an error when the savings settings read fails", async () => {
    stubTables({
      microgrid_savings_settings: { data: null, error: { message: "settings unavailable" } },
    });
    const html = renderToStaticMarkup(await callPage());
    expect(html).toContain("Error loading the grid tariff: settings unavailable");
  });

  it("still shows the microgrid error first", async () => {
    stubTables({ microgrids: { data: null, error: { message: "no microgrid" } } });
    const html = renderToStaticMarkup(await callPage());
    expect(html).toContain("Error loading microgrid: no microgrid");
    expect(html).not.toContain("Grid tariff (what the microgrid pays the utility)");
  });
});
