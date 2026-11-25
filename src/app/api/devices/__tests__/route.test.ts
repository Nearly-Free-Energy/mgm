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
 *   (h) The same componentId twice, after trimming → 400
 *       `duplicate_component_id` naming it, before any database call
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockUpsert = vi.fn(() => ({ select: mockSelect }));
const mockFrom = vi.fn(() => ({ upsert: mockUpsert }));

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
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          edge_id: VALID_UUID,
          openems_component_id: "meter0",
          device_type: "consumption_meter",
          name: "Main Meter",
        }),
      ]),
      expect.objectContaining({ onConflict: "edge_id,openems_component_id" })
    );
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
      expect(mockUpsert).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            openems_component_id: "meter0",
            name: "meter0",
          }),
        ],
        expect.anything()
      );
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

  describe("(h) the same componentId twice", () => {
    it.each([
      ["identical", "meter0", "meter0"],
      ["only spaces apart", "meter0", " meter0"],
      ["both padded", "  meter0", "meter0\t"],
    ])(
      "refuses two entries that are %s with 400 duplicate_component_id before any database call",
      async (_label, first, second) => {
        const { gateRoute } = await import("@/lib/runtime/gate");
        const { POST } = await import("../route");
        const res = await POST(
          makeRequest({
            edgeId: VALID_UUID,
            devices: [
              { ...VALID_DEVICE, componentId: first, name: "Meter A" },
              { ...VALID_DEVICE, componentId: "ess0", deviceType: "battery", name: "Battery" },
              { ...VALID_DEVICE, componentId: second, name: "Meter B" },
            ],
          })
        );
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.reason).toBe("duplicate_component_id");
        expect(json.componentId).toBe("meter0");
        expect(json.error).toContain("'meter0'");
        expect(gateRoute).not.toHaveBeenCalled();
        expect(mockFrom).not.toHaveBeenCalled();
      }
    );

    it("saves entries whose ids differ", async () => {
      mockSelect.mockResolvedValueOnce({ data: [], error: null });
      const { POST } = await import("../route");
      const res = await POST(
        makeRequest({
          edgeId: VALID_UUID,
          devices: [
            VALID_DEVICE,
            { ...VALID_DEVICE, componentId: " meter1 ", name: "Second Meter" },
          ],
        })
      );
      expect(res.status).toBe(200);
      expect(mockUpsert).toHaveBeenCalledWith(
        [
          expect.objectContaining({ openems_component_id: "meter0" }),
          expect.objectContaining({ openems_component_id: "meter1" }),
        ],
        expect.anything()
      );
    });
  });
});
