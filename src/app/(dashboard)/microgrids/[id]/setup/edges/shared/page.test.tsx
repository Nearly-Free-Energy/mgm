// Setup > Edges > Shared — server component test (D2 / #53).
//
// The ticket's seeded scenario has every device linked to a household
// (10 households × 10 consumption_meter devices, all linked). So the
// primary test path is the empty state.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

// Stub getHierarchyLevels so page tests don't need a full Supabase mock chain.
vi.mock("@/lib/hierarchy", () => ({
  getHierarchyLevels: vi.fn().mockResolvedValue([]),
}));

import SharedDevicesPage from "./page";

function buildEmptyQuery() {
  return {
    select: () => ({
      eq: () => ({
        order: () => ({
          returns: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  };
}

function buildSharedDevicesQuery(devices: unknown[]) {
  return {
    select: () => ({
      eq: () => ({
        order: () => ({
          returns: () =>
            Promise.resolve({ data: devices, error: null }),
        }),
      }),
      in: () =>
        Promise.resolve({
          data: [{ id: "edge-1", name: "Metering Pi" }],
          error: null,
        }),
    }),
  };
}

function buildErrorQuery() {
  return {
    select: () => ({
      eq: () => ({
        order: () => ({
          returns: () =>
            Promise.resolve({
              data: null,
              error: {
                code: "42501",
                message: "permission denied for view microgrid_shared_devices",
                details: null,
                hint: null,
              },
            }),
        }),
      }),
    }),
  };
}

describe("SharedDevicesPage", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("shows a plain message and logs the error when the view query fails", async () => {
    mockFrom.mockImplementation(() => buildErrorQuery());

    const jsx = await SharedDevicesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Could not load shared devices");
    expect(html).not.toContain("permission denied");
    expect(html).not.toContain("microgrid_shared_devices");
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleError.mock.calls[0]![0] as string);
    expect(logged).toMatchObject({
      event: "shared_devices.query_error",
      microgridId: "mg-1",
      code: "42501",
    });
  });

  it("renders the empty-state copy when every device is linked to a household", async () => {
    mockFrom.mockImplementation(() => buildEmptyQuery());

    const jsx = await SharedDevicesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain(
      "All devices on this microgrid are linked to a household",
    );
  });

  it("renders rows for unlinked devices when the view returns data", async () => {
    mockFrom.mockImplementation((tableName: string) => {
      if (tableName === "microgrid_shared_devices") {
        return buildSharedDevicesQuery([
          {
            id: "dev-1",
            name: "Grid meter",
            device_type: "grid_meter",
            openems_component_id: "meterGrid0",
            edge_id: "edge-1",
            microgrid_id: "mg-1",
          },
        ]);
      }
      // edges lookup
      return buildSharedDevicesQuery([]);
    });

    const jsx = await SharedDevicesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Grid meter");
    expect(html).toContain("meterGrid0");
    expect(html).toContain("Metering Pi");
  });
});
