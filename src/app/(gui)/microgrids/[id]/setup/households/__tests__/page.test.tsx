/**
 * Setup > Households page — how it loads.
 *
 * Its reads start together instead of after the access check and the
 * breadcrumb, the microgrid's edges are read once and feed both the device
 * query and the edge names, and the error banner keeps its precedence.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const MICROGRID_ID = "770e8400-e29b-41d4-a716-446655442000";

type Reply = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  replies: {} as Record<string, Reply>,
  tables: [] as string[],
  deviceEdgeIds: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      db.tables.push(table);
      const reply = () => Promise.resolve(db.replies[table] ?? { data: [], error: null });
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        in: (_column: string, values: unknown) => {
          if (table === "devices") db.deviceEdgeIds = values;
          return builder;
        },
        returns: () => builder,
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

vi.mock("../households-section", () => ({
  HouseholdsSection: (props: Record<string, unknown>) =>
    React.createElement("pre", { "data-testid": "section" }, JSON.stringify(props)),
}));

import SetupHouseholdsPage from "../page";

const render = async () =>
  renderToStaticMarkup(
    (await SetupHouseholdsPage({ params: Promise.resolve({ id: MICROGRID_ID }) })) as React.ReactElement
  );

function sectionProps(html: string) {
  const m = html.match(/<pre data-testid="section">([^<]*)<\/pre>/);
  if (!m) throw new Error("section not rendered");
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

beforeEach(() => {
  vi.clearAllMocks();
  db.tables = [];
  db.deviceEdgeIds = null;
  db.replies = {
    edges: {
      data: [
        { id: "edge-1", name: "North", openems_edge_id: "edge0" },
        { id: "edge-2", name: "South", openems_edge_id: null },
      ],
      error: null,
    },
    households: { data: [{ id: "hh-1", display_name: "Aaron" }], error: null },
    devices: {
      data: [{ id: "dev-1", name: "Meter 1", device_type: "consumption_meter", edge_id: "edge-1" }],
      error: null,
    },
    household_devices: { data: [], error: null },
  };
  hierarchy.getHierarchyLevels.mockResolvedValue([]);
  access.requestUserCanAccessMicrogrid.mockResolvedValue(true);
});

describe("SetupHouseholdsPage", () => {
  it("starts its reads without waiting for the breadcrumb or the access check", async () => {
    let releaseBreadcrumb: (levels: never[]) => void = () => {};
    hierarchy.getHierarchyLevels.mockReturnValue(new Promise((resolve) => { releaseBreadcrumb = resolve; }));
    let releaseAccess: (value: boolean) => void = () => {};
    access.requestUserCanAccessMicrogrid.mockReturnValue(new Promise((resolve) => { releaseAccess = resolve; }));

    const page = SetupHouseholdsPage({ params: Promise.resolve({ id: MICROGRID_ID }) });
    await vi.waitFor(() =>
      expect([...db.tables].sort()).toEqual(["devices", "edges", "household_devices", "households"])
    );
    releaseBreadcrumb([]);
    releaseAccess(false);
    expect(sectionProps(renderToStaticMarkup((await page) as React.ReactElement)).canManage).toBe(false);
  });

  it("reads the edges once and filters devices by their ids", async () => {
    const props = sectionProps(await render());
    expect(db.tables.filter((t) => t === "edges")).toHaveLength(1);
    expect(db.deviceEdgeIds).toEqual(["edge-1", "edge-2"]);
    expect(props.edges).toEqual([
      { id: "edge-1", name: "North", openems_edge_id: "edge0" },
      { id: "edge-2", name: "South", openems_edge_id: "" },
    ]);
    expect(props.edgeIdsWithoutConsumptionMeter).toEqual(["edge-2"]);
    expect(props.availableMeters[0]).toMatchObject({ id: "dev-1", edge_name: "North" });
    expect(props.canManage).toBe(true);
  });

  it("shows the edges error when the edge read fails", async () => {
    db.replies.edges = { data: null, error: { message: "edges failed" } };
    const html = await render();
    expect(html).toContain("Error loading data:");
    expect(html).toContain("edges failed");
    expect(db.deviceEdgeIds).toEqual([]);
  });

  it("keeps the error precedence: households, devices, assignments, edges", async () => {
    db.replies.devices = { data: null, error: { message: "devices failed" } };
    db.replies.edges = { data: null, error: { message: "edges failed" } };
    expect(await render()).toContain("devices failed");

    db.replies.households = { data: null, error: { message: "households failed" } };
    expect(await render()).toContain("households failed");
  });
});
