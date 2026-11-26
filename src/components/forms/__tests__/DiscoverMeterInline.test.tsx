// @vitest-environment jsdom
/**
 * DiscoverMeterInline — the "Not listed" note (#262).
 *
 * The wizard offers only consumption meters, so its note names only the
 * skipped components discovery would have suggested as consumption meters.
 * A skipped battery or inverter is no meter left out. `<DiscoverDevices>`,
 * which lists every type, names all of them (its own tests).
 *
 * The rest of this component is covered through the wizard in
 * TenantWizard.test.tsx § (k).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DiscoverMeterInline } from "../DiscoverMeterInline";
import type {
  DiscoveredDevice,
  EdgeDiscoveryResponse,
  SkippedComponent,
} from "@/lib/openems/types";

// Radix RadioGroup needs ResizeObserver, which jsdom lacks.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const EDGE = { id: "edge-1", name: "Metering Pi", openems_edge_id: "edge1" };

function skippedAs(
  componentId: string,
  suggestedDeviceType: SkippedComponent["suggestedDeviceType"]
): SkippedComponent {
  return { componentId, reason: "invalid_component_id", suggestedDeviceType };
}

function meter(componentId: string): DiscoveredDevice {
  return {
    componentId,
    factoryId: "io.openems.impl.meter.consumption.ConsumptionMeter",
    alias: `House ${componentId}`,
    nature: "io.openems.edge.meter.api.ElectricityMeter",
    openemsChannelAddress: `${componentId}/ActiveConsumptionEnergy`,
    suggestedDeviceType: "consumption_meter",
    alreadyAdded: false,
  };
}

function respond(body: EdgeDiscoveryResponse) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => body,
  } as Response);
}

async function discover() {
  render(
    <DiscoverMeterInline
      edges={[EDGE]}
      edgeIdsWithoutConsumptionMeter={[EDGE.id]}
      microgridId="mg-1"
      onDevicePersisted={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /Discover meters/i }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Discover meters/i })).toHaveProperty(
      "disabled",
      false
    )
  );
}

let fetchMock: ReturnType<typeof vi.spyOn>;

describe("DiscoverMeterInline — skipped components", () => {
  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names only the skipped consumption meters", async () => {
    respond({
      edgeId: "edge1",
      online: true,
      devices: [meter("meter0")],
      skipped: [
        skippedAs("meter 1", "consumption_meter"),
        skippedAs("ess 0", "battery"),
        skippedAs("inverter/0", "inverter"),
        skippedAs("grid meter", "grid_meter"),
      ],
    });
    await discover();

    expect(screen.getByText(/Not listed: 1 consumption meter whose/)).toBeDefined();
    expect(screen.getByText("meter 1")).toBeDefined();
    expect(screen.queryByText(/ess 0/)).toBeNull();
    expect(screen.queryByText(/inverter\/0/)).toBeNull();
    expect(screen.queryByText(/grid meter/)).toBeNull();
    // The listed meter is still offered.
    expect(screen.getByRole("radio")).toBeDefined();
  });

  it("counts several skipped consumption meters in the plural", async () => {
    respond({
      edgeId: "edge1",
      online: true,
      devices: [],
      skipped: [
        skippedAs("meter 1", "consumption_meter"),
        skippedAs("ess 0", "battery"),
        skippedAs("meter/2", "consumption_meter"),
      ],
    });
    await discover();

    expect(screen.getByText(/Not listed: 2 consumption meters whose/)).toBeDefined();
    expect(screen.getByText("meter 1, meter/2")).toBeDefined();
  });

  it("shows no note when only components of other types were skipped", async () => {
    respond({
      edgeId: "edge1",
      online: true,
      devices: [],
      skipped: [skippedAs("ess 0", "battery"), skippedAs("pv meter", "pv_meter")],
    });
    await discover();

    expect(screen.getByText(/No new consumption meters on this edge/i)).toBeDefined();
    expect(screen.queryByText(/Not listed:/)).toBeNull();
    // The edge answered with components, so the online hint stays out.
    expect(screen.queryByText(/Make sure the edge is online/i)).toBeNull();
  });

  it("shows no note and keeps the online hint when nothing was skipped", async () => {
    respond({ edgeId: "edge1", online: true, devices: [] });
    await discover();

    expect(screen.getByText(/No new consumption meters on this edge/i)).toBeDefined();
    expect(screen.queryByText(/Not listed:/)).toBeNull();
    expect(screen.getByText(/Make sure the edge is online/i)).toBeDefined();
  });
});
