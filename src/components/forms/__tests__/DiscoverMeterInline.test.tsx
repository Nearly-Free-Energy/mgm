// @vitest-environment jsdom
/**
 * DiscoverMeterInline component tests.
 *
 * The "Not listed" note (#262). The wizard offers only consumption meters,
 * so its note names only the skipped components discovery would have
 * suggested as consumption meters. A skipped battery or inverter is no meter
 * left out. `<DiscoverDevices>`, which lists every type, names all of them
 * (its own tests).
 *
 * A meter saved from the picker (#279). POST /api/devices refuses a device
 * already saved on the edge (409 metering_devices_already_saved), so a
 * saved meter leaves the candidates rather than be offered, and sent,
 * again:
 *   (a) after Save & select, the saved meter leaves the candidates, the
 *       others stay, and the device is posted once
 *   (b) after the only candidate is saved, the picker says there is no new
 *       consumption meter, without the online hint and without calling the
 *       saved meter unclassified
 *   (c) a discovery whose consumption meters are all saved says the same
 *   (d) and still names the unsaved devices of other types found beside
 *       them, with the hint to change a device's type
 *
 * Devices found, none classified as a consumption meter: the message says
 * that none can bill a tenant, and in the singular that it cannot.
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

describe("DiscoverMeterInline — devices not classified as consumption meters", () => {
  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function other(componentId: string): DiscoveredDevice {
    return { ...meter(componentId), openemsChannelAddress: null, suggestedDeviceType: "other" };
  }

  it("says the one device found cannot bill a tenant", async () => {
    respond({ edgeId: "edge1", online: true, devices: [other("meter10")] });
    await discover();

    expect(screen.getByText(/so it cannot bill a tenant\./)).toBeDefined();
    expect(screen.queryByText(/so it can bill/)).toBeNull();
  });

  it("says none of the devices found can bill a tenant", async () => {
    respond({ edgeId: "edge1", online: true, devices: [other("meter10"), other("meter11")] });
    await discover();

    expect(screen.getByText(/so none can bill a tenant\./)).toBeDefined();
  });
});

describe("DiscoverMeterInline — a meter saved from the picker", () => {
  const onDevicePersisted = vi.fn();

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
    onDevicePersisted.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function respondSaved(id: string, name: string, componentId: string) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        saved: [{ id, name, device_type: "consumption_meter", openems_component_id: componentId }],
      }),
    } as Response);
  }

  function renderPicker() {
    render(
      <DiscoverMeterInline
        edges={[EDGE]}
        edgeIdsWithoutConsumptionMeter={[EDGE.id]}
        microgridId="mg-1"
        onDevicePersisted={onDevicePersisted}
      />
    );
  }

  // fetch's own parameters; the spy's type does not carry them.
  type FetchCall = Parameters<typeof fetch>;
  const devicePosts = () =>
    (fetchMock.mock.calls as FetchCall[]).filter(([url]) => url === "/api/devices");

  it("(a) takes a saved meter out of the candidates, so it is not posted again", async () => {
    respond({ edgeId: "edge1", online: true, devices: [meter("meter9"), meter("meter8")] });
    respondSaved("dev-9", "House meter9", "meter9");
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /Discover meters/i }));
    await waitFor(() => expect(screen.getByText("House meter9")).toBeDefined());
    expect(screen.getAllByRole("radio")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Save & select/i }));

    await waitFor(() => expect(onDevicePersisted).toHaveBeenCalledTimes(1));
    expect(onDevicePersisted).toHaveBeenCalledWith(expect.objectContaining({ id: "dev-9", edge_id: EDGE.id }));

    // meter9 is gone; meter8, not saved, is still offered.
    await waitFor(() => expect(screen.queryByText("House meter9")).toBeNull());
    expect(screen.getByText("House meter8")).toBeDefined();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(devicePosts()).toHaveLength(1);
    expect(JSON.parse(devicePosts()[0][1]!.body as string).devices[0].componentId).toBe("meter9");
  });

  it("(b) says there is no new meter once the only candidate is saved", async () => {
    respond({ edgeId: "edge1", online: true, devices: [meter("meter9")] });
    respondSaved("dev-9", "House meter9", "meter9");
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /Discover meters/i }));
    await waitFor(() => expect(screen.getByText("House meter9")).toBeDefined());
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Save & select/i }));

    await waitFor(() => expect(screen.getByText(/No new consumption meters on this edge/i)).toBeDefined());
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Save & select/i })).toBeNull();
    expect(screen.queryByText(/not classified as a consumption meter/i)).toBeNull();
    expect(screen.queryByText(/Make sure the edge is online/i)).toBeNull();
    expect(devicePosts()).toHaveLength(1);
  });

  it("(c) says there is no new meter when every consumption meter found is saved", async () => {
    respond({ edgeId: "edge1", online: true, devices: [{ ...meter("meter9"), alreadyAdded: true }] });
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /Discover meters/i }));

    await waitFor(() => expect(screen.getByText(/No new consumption meters on this edge/i)).toBeDefined());
    expect(screen.queryByText(/not classified as a consumption meter/i)).toBeNull();
    expect(screen.queryByText(/Make sure the edge is online/i)).toBeNull();
  });

  it("(d) still names the unsaved devices of other types when every consumption meter is saved", async () => {
    const unsaved = (componentId: string, alias: string): DiscoveredDevice => ({
      componentId,
      factoryId: "Meter.Chint.DDSU666",
      alias,
      nature: "io.openems.edge.meter.api.ElectricityMeter",
      openemsChannelAddress: null,
      suggestedDeviceType: "other",
      alreadyAdded: false,
    });
    respond({
      edgeId: "edge1",
      online: true,
      devices: [
        { ...meter("meter9"), alreadyAdded: true },
        unsaved("meter10", "Workshop Meter"),
        { ...meter("ess0"), alias: "Saved battery", suggestedDeviceType: "battery", alreadyAdded: true },
      ],
    });
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /Discover meters/i }));

    await waitFor(() => expect(screen.getByText(/No new consumption meters on this edge/i)).toBeDefined());
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByText(/Make sure the edge is online/i)).toBeNull();
    // The unsaved device of another type is named, with its type and the hint.
    expect(screen.getByText(/Also found 1 device not classified as a consumption meter/i)).toBeDefined();
    expect(screen.getByText(/Workshop Meter/)).toBeDefined();
    expect(screen.getByText(/— Other/)).toBeDefined();
    expect(screen.getByText(/change its type to Consumption meter/i)).toBeDefined();
    // Saved devices are on the edge's device list already: neither is named.
    expect(screen.queryByText(/House meter9/)).toBeNull();
    expect(screen.queryByText(/Saved battery/)).toBeNull();
  });
});
