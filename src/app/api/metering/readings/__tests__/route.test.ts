import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  dispose: vi.fn(),
  getConsumption: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/metering/compose", () => ({
  composeMetering: (...args: unknown[]) => mocks.compose(...args),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mocks.from }),
}));

const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const ORG_ID = "660e8400-e29b-41d4-a716-446655440099";

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/metering/readings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BODY = {
  microgrid_id: MG_ID,
  start_date: "2026-09-01",
  end_date: "2026-09-30",
};

describe("POST /api/metering/readings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: MG_ID, communities: { org_id: ORG_ID } },
            error: null,
          }),
        }),
      }),
    }));
    mocks.compose.mockResolvedValue({
      ok: true,
      data: {
        metering: { getConsumption: mocks.getConsumption },
        dispose: mocks.dispose,
      },
    });
  });

  it("404 when the microgrid is hidden or missing", async () => {
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }));
    const { POST } = await import("../route");
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(404);
  });

  it("returns consumption rows and disposes", async () => {
    const rows = [
      {
        deviceId: "dev-1",
        householdId: null,
        usageKwh: 12.5,
        source: "openems",
        readAt: "2026-10-01T00:00:00Z",
      },
    ];
    mocks.getConsumption.mockResolvedValue({ ok: true, data: rows });
    const { POST } = await import("../route");
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ readings: rows });
    expect(mocks.getConsumption).toHaveBeenCalledWith({
      microgrid_id: MG_ID,
      device_ids: undefined,
      household_ids: undefined,
      start_date: "2026-09-01",
      end_date: "2026-09-30",
      timezone: undefined,
      provider: "openems",
    });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it("maps capability errors and still disposes", async () => {
    mocks.getConsumption.mockResolvedValue({
      ok: false,
      status: 503,
      code: "METERING_UNAVAILABLE",
      message: "Down.",
    });
    const { POST } = await import("../route");
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.code).toBe("METERING_UNAVAILABLE");
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
