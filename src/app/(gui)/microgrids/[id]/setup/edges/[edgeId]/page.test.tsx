// Setup > Edges > [edgeId] — server component test.
//
// Covers when the page decrypts the microgrid's stored OpenEMS credentials
// to colour the empty state: only after currentUserCanAccessMicrogrid (which
// asks Auth through getUser) allows it, and only for an edge linked to
// OpenEMS.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

const getEdgesStatusMock = vi.fn();
vi.mock("@/lib/openems", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openems")>(
    "@/lib/openems",
  );
  return {
    ...actual,
    createOpenEmsClient: () => ({ getEdgesStatus: getEdgesStatusMock }),
  };
});

vi.mock("@/lib/openems/config", () => ({
  getMicrogridEmsConfig: vi
    .fn()
    .mockResolvedValue({ type: "direct_url", url: "http://localhost:8075" }),
}));

vi.mock("@/lib/hierarchy", () => ({
  getHierarchyLevels: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: vi.fn().mockResolvedValue(true),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// Client components (useRouter, Radix) that cannot render in this test.
vi.mock("@/components/DiscoverDevices", () => ({ DiscoverDevices: () => null }));
vi.mock("./edge-detail-configure-button", () => ({
  EdgeDetailConfigureButton: () => null,
}));
vi.mock("./device-row-actions", () => ({ DeviceRowActions: () => null }));
vi.mock("@/components/forms/DeleteEntityButton", () => ({
  DeleteEntityButton: () => null,
}));

import EdgeDetailPage from "./page";
import * as accessModule from "@/lib/auth/access";
import * as configModule from "@/lib/openems/config";

// Every query chain resolves to { data, error: null }, whatever it calls.
function buildQuery(data: unknown) {
  const result = () => Promise.resolve({ data, error: null });
  function chain(): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "single" || prop === "returns") return result;
        if (prop === "then") {
          return (resolve: (value: { data: unknown; error: null }) => unknown) =>
            result().then(resolve);
        }
        return () => chain();
      },
    });
  }
  return chain();
}

function mockTables(edge: { openems_edge_id: string | null }) {
  mockFrom.mockImplementation((table: string) => {
    if (table === "edges") {
      return buildQuery({ id: "edge-1", name: "Metering Pi", role: null, ...edge });
    }
    return buildQuery([]);
  });
}

function renderPage() {
  return EdgeDetailPage({
    params: Promise.resolve({ id: "mg-1", edgeId: "edge-1" }),
  });
}

describe("EdgeDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checks a linked edge's status with the stored credentials", async () => {
    mockTables({ openems_edge_id: "edge0" });
    getEdgesStatusMock.mockResolvedValue([{ edgeId: "edge0", online: true }]);

    const html = renderToStaticMarkup((await renderPage()) as React.ReactElement);

    expect(configModule.getMicrogridEmsConfig).toHaveBeenCalledWith(
      expect.anything(),
      "mg-1",
    );
    expect(html).toContain("Run discovery to see meters");
  });

  it("does not decrypt the stored credentials when the access check fails", async () => {
    // currentUserCanAccessMicrogrid asks Auth (getUser), which refuses a
    // session signed out elsewhere even while its token still verifies.
    vi.mocked(accessModule.currentUserCanAccessMicrogrid).mockResolvedValueOnce(
      false,
    );
    mockTables({ openems_edge_id: "edge0" });

    const html = renderToStaticMarkup((await renderPage()) as React.ReactElement);

    expect(configModule.getMicrogridEmsConfig).not.toHaveBeenCalled();
    expect(getEdgesStatusMock).not.toHaveBeenCalled();
    expect(html).toContain("Edge is offline");
  });

  it("does not look up credentials for an edge not linked to OpenEMS", async () => {
    mockTables({ openems_edge_id: null });

    await renderPage();

    expect(configModule.getMicrogridEmsConfig).not.toHaveBeenCalled();
  });
});
