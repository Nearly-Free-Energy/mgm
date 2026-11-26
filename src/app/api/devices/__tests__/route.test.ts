/**
 * POST /api/devices — unit tests (F #67)
 *
 * All Supabase I/O is mocked — no real DB hits.
 *
 * Cases:
 *   (a) Missing edgeId → 400 "Request body must include edgeId and devices"
 *   (b) Non-UUID edgeId ("edge0") → 400 "Invalid edgeId — expected UUID."
 *   (c) Valid UUID + devices not an array → 400 "devices must be a non-empty array"
 *   (d) Valid UUID + empty devices array → 400 "devices must be a non-empty array"
 *   (e) Valid UUID + valid device row → 200 { saved: [...] }
 *   (g) componentId format: trimmed and stored; outside the pattern → 400
 *       `invalid_component_id`
 *   (h) a device already saved on the edge, by its trimmed componentId →
 *       409 `metering_devices_already_saved` naming it, alone or in a batch
 *       with new devices, and nothing is inserted; so too when another
 *       request saves it between the check and the insert (23505)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockInsert = vi.fn(() => ({ select: mockSelect }));
// The check for devices already saved: select().eq("edge_id").in("openems_component_id").
// By default none is.
type Read = { data: { openems_component_id: string }[]; error: unknown };
const mockIn = vi.fn<(column: string, ids: string[]) => Promise<Read>>(async () => ({ data: [], error: null }));
const mockEq = vi.fn(() => ({ in: mockIn }));
const mockRead = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockRead, insert: mockInsert }));

// The MGM runtime gate is covered by src/app/api/__tests__/runtime-gate-wiring.test.ts.
vi.mock("@/lib/runtime/gate", () => ({ gateRoute: vi.fn(async () => null) }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

const VALID_DEVICE = {
  componentId: "meter0",
  deviceType: "consumption_meter",
  name: "Main Meter",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) Missing edgeId field → 400 with presence-check message
  it("(a) returns 400 when edgeId is missing", async () => {
    const { POST } = await import("../route");
    const req = makeRequest({ devices: [VALID_DEVICE] });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Request body must include edgeId and devices");
  });

  // (b) Non-UUID edgeId → 400 with UUID error message
  it("(b) returns 400 when edgeId is not a UUID", async () => {
    const { POST } = await import("../route");
    const req = makeRequest({ edgeId: "edge0", devices: [VALID_DEVICE] });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid edgeId — expected UUID.");
  });

  // (c) Valid UUID + devices not an array → 400
  it("(c) returns 400 when devices is not an array", async () => {
    const { POST } = await import("../route");
    const req = makeRequest({ edgeId: VALID_UUID, devices: "not-an-array" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("devices must be a non-empty array");
  });

  // (d) Valid UUID + empty devices array → 400 (preserves current behavior)
  it("(d) returns 400 when devices is an empty array", async () => {
    const { POST } = await import("../route");
    const req = makeRequest({ edgeId: VALID_UUID, devices: [] });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("devices must be a non-empty array");
  });

  // (e) Valid UUID + valid device row → 200 with saved rows
  it("(e) returns 200 with saved rows for valid payload", async () => {
    const savedRow = {
      id: "device-uuid-1",
      name: "Main Meter",
      device_type: "consumption_meter",
      openems_component_id: "meter0",
    };

    mockSelect.mockResolvedValueOnce({ data: [savedRow], error: null });

    const { POST } = await import("../route");
    const req = makeRequest({
      edgeId: VALID_UUID,
      devices: [VALID_DEVICE],
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ saved: [savedRow] });

    // Verify Supabase was called with snake_case mapped rows
    expect(mockFrom).toHaveBeenCalledWith("devices");
    expect(mockEq).toHaveBeenCalledWith("edge_id", VALID_UUID);
    expect(mockIn).toHaveBeenCalledWith("openems_component_id", ["meter0"]);
    expect(mockInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        edge_id: VALID_UUID,
        openems_component_id: "meter0",
        device_type: "consumption_meter",
        name: "Main Meter",
      }),
    ]);
  });

  // (f) openemsChannelAddress: null is accepted — non-billable devices registered for observability
  it("(f) returns 200 when openemsChannelAddress is null (non-billable device)", async () => {
    const savedRow = {
      id: "device-uuid-2",
      name: "Main Battery",
      device_type: "battery",
      openems_component_id: "ess0",
    };

    mockSelect.mockResolvedValueOnce({ data: [savedRow], error: null });

    const { POST } = await import("../route");
    const req = makeRequest({
      edgeId: VALID_UUID,
      devices: [
        {
          componentId: "ess0",
          factoryId: "io.openems.edge.ess.generic.ManagedSymmetricEss",
          openemsChannelAddress: null,
          deviceType: "battery",
          name: "Main Battery",
        },
      ],
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ saved: [savedRow] });
  });

  describe("(g) componentId format", () => {
    it("stores the trimmed componentId", async () => {
      mockSelect.mockResolvedValueOnce({ data: [], error: null });
      const { POST } = await import("../route");
      const res = await POST(
        makeRequest({
          edgeId: VALID_UUID,
          devices: [{ ...VALID_DEVICE, componentId: "  meter0  ", name: " " }],
        })
      );
      expect(res.status).toBe(200);
      expect(mockInsert).toHaveBeenCalledWith([
        expect.objectContaining({
          openems_component_id: "meter0",
          name: "meter0",
        }),
      ]);
    });

    it.each([
      ["empty", ""],
      ["only spaces", "   "],
      ["a space inside", "meter 0"],
      ["a slash", "meter0/ActivePower"],
      ["a parenthesis", "meter0)"],
      ["65 characters", "m".repeat(65)],
    ])("refuses a componentId that is %s with 400 invalid_component_id", async (_label, componentId) => {
      const { POST } = await import("../route");
      const res = await POST(
        makeRequest({
          edgeId: VALID_UUID,
          devices: [VALID_DEVICE, { ...VALID_DEVICE, componentId }],
        })
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.reason).toBe("invalid_component_id");
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  describe("(h) devices already saved on the edge", () => {
    const saved = (...ids: string[]) => ({ data: ids.map((id) => ({ openems_component_id: id })), error: null });

    it("refuses a device already saved with 409 naming it, and inserts nothing", async () => {
      mockIn.mockResolvedValueOnce(saved("meter0"));
      const { POST } = await import("../route");
      const res = await POST(makeRequest({ edgeId: VALID_UUID, devices: [VALID_DEVICE] }));

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json).toEqual({
        error: "Already saved on this edge: meter0. Nothing was saved. Discover again to see which are new.",
        code: "metering_devices_already_saved",
        componentIds: ["meter0"],
      });
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("refuses a batch of new and saved devices whole, naming only the saved ones", async () => {
      mockIn.mockResolvedValueOnce(saved("meter2", "meter0"));
      const { POST } = await import("../route");
      const res = await POST(
        makeRequest({
          edgeId: VALID_UUID,
          devices: [
            VALID_DEVICE,
            { ...VALID_DEVICE, componentId: "meter1", name: "New meter" },
            { ...VALID_DEVICE, componentId: "meter2", deviceType: "battery" },
          ],
        })
      );

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe("metering_devices_already_saved");
      // In the body's order.
      expect(json.componentIds).toEqual(["meter0", "meter2"]);
      expect(mockIn).toHaveBeenCalledWith("openems_component_id", ["meter0", "meter1", "meter2"]);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("checks the trimmed componentId, as it is stored", async () => {
      mockIn.mockResolvedValueOnce(saved("meter0"));
      const { POST } = await import("../route");
      const res = await POST(makeRequest({ edgeId: VALID_UUID, devices: [{ ...VALID_DEVICE, componentId: "  meter0 " }] }));

      expect(res.status).toBe(409);
      expect((await res.json()).componentIds).toEqual(["meter0"]);
      expect(mockIn).toHaveBeenCalledWith("openems_component_id", ["meter0"]);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("answers 409 naming a device another request saved after the check", async () => {
      mockIn.mockResolvedValueOnce(saved()).mockResolvedValueOnce(saved("meter0"));
      mockSelect.mockResolvedValueOnce({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "devices_edge_id_openems_component_id_key"' },
      });
      const { POST } = await import("../route");
      const res = await POST(makeRequest({ edgeId: VALID_UUID, devices: [VALID_DEVICE] }));

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "metering_devices_already_saved", componentIds: ["meter0"] });
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });

    it("answers 503 and inserts nothing when the saved devices cannot be read", async () => {
      mockIn.mockResolvedValueOnce({ data: [], error: { code: "57014", message: "canceling statement due to statement timeout" } });
      const { POST } = await import("../route");
      const res = await POST(makeRequest({ edgeId: VALID_UUID, devices: [VALID_DEVICE] }));

      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("Could not check this edge's saved devices. Try again shortly.");
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
});
