// @vitest-environment jsdom
/**
 * DiscoverMeterInline component tests (#279).
 *
 * POST /api/devices refuses a device already saved on the edge (409
 * metering_devices_already_saved), so a meter saved from the inline picker
 * must leave its candidates rather than be offered, and sent, again.
 *
 * Covers:
 *   (a) after Save & select, the saved meter leaves the candidates, the
 *       others stay, and the device is posted once
 *   (b) after the only candidate is saved, the picker says there is no new
 *       consumption meter, without the online hint and without calling the
 *       saved meter unclassified
 *   (c) a discovery whose consumption meters are all saved says the same
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DiscoverMeterInline } from "../DiscoverMeterInline";
import type { DiscoveredDevice } from "@/lib/openems/types";

const EDGE = { id: "550e8400-e29b-41d4-a716-446655440001", name: "Metering Pi", openems_edge_id: "edge0" };

function meter(componentId: string, alias: string, alreadyAdded = false): DiscoveredDevice {
  return {
    componentId,
    factoryId: "io.openems.impl.meter.consumption.ConsumptionMeter",
    alias,
    nature: "io.openems.edge.meter.api.ElectricityMeter",
    openemsChannelAddress: `${componentId}/ActiveConsumptionEnergy`,
    suggestedDeviceType: "consumption_meter",
    alreadyAdded,
  };
}

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function savedResponse(id: string, name: string, componentId: string): Response {
  return respond({ saved: [{ id, name, device_type: "consumption_meter", openems_component_id: componentId }] });
}

describe("DiscoverMeterInline", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;
  const onDevicePersisted = vi.fn();

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
    onDevicePersisted.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  const devicePosts = () => fetchMock.mock.calls.filter(([url]) => url === "/api/devices");

  it("(a) takes a saved meter out of the candidates, so it is not posted again", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ edgeId: "edge0", online: true, devices: [meter("meter9", "M9"), meter("meter8", "M8")] }))
      .mockResolvedValueOnce(savedResponse("dev-9", "M9", "meter9"));
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /Discover meters/i }));
    await waitFor(() => expect(screen.getByText("M9")).toBeDefined());
    expect(screen.getAllByRole("radio")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Save & select/i }));

    await waitFor(() => expect(onDevicePersisted).toHaveBeenCalledTimes(1));
    expect(onDevicePersisted).toHaveBeenCalledWith(expect.objectContaining({ id: "dev-9", edge_id: EDGE.id }));

    // M9 is gone; M8, not saved, is still offered.
    await waitFor(() => expect(screen.queryByText("M9")).toBeNull());
    expect(screen.getByText("M8")).toBeDefined();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(devicePosts()).toHaveLength(1);
    expect(JSON.parse(devicePosts()[0][1]!.body as string).devices[0].componentId).toBe("meter9");
  });

  it("(b) says there is no new meter once the only candidate is saved", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ edgeId: "edge0", online: true, devices: [meter("meter9", "M9")] }))
      .mockResolvedValueOnce(savedResponse("dev-9", "M9", "meter9"));
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /Discover meters/i }));
    await waitFor(() => expect(screen.getByText("M9")).toBeDefined());
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
    fetchMock.mockResolvedValueOnce(
      respond({ edgeId: "edge0", online: true, devices: [meter("meter9", "M9", true)] })
    );
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /Discover meters/i }));

    await waitFor(() => expect(screen.getByText(/No new consumption meters on this edge/i)).toBeDefined());
    expect(screen.queryByText(/not classified as a consumption meter/i)).toBeNull();
    expect(screen.queryByText(/Make sure the edge is online/i)).toBeNull();
  });
});
