import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  dispose: vi.fn(),
  recordOpeningRegister: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/metering/compose", () => ({
  composeMetering: (...args: unknown[]) => mocks.compose(...args),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mocks.from }),
}));

const DEV_ID = "660e8400-e29b-41d4-a716-44665544aaaa";
const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const ORG_ID = "660e8400-e29b-41d4-a716-446655440099";

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/meter-readings/opening", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BODY = {
  device_id: DEV_ID,
  reading_kwh: 1234.5,
  read_at: "2026-09-01T00:00:00Z",
};

describe("POST /api/meter-readings/opening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) => {
      if (table === "devices") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: DEV_ID, edges: { microgrid_id: MG_ID } },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: MG_ID, communities: { org_id: ORG_ID } },
              error: null,
            }),
          }),
        }),
      };
    });
    mocks.compose.mockResolvedValue({
      ok: true,
      data: {
        metering: { recordOpeningRegister: mocks.recordOpeningRegister },
        dispose: mocks.dispose,
      },
    });
  });

  it("404 when the meter is hidden or missing", async () => {
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }));
    const { POST } = await import("../route");
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(404);
  });

  it("201 records the opening register and disposes", async () => {
    mocks.recordOpeningRegister.mockResolvedValue({
      ok: true,
      data: { id: "reading-1" },
    });
    const { POST } = await import("../route");
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ reading: { id: "reading-1" } });
    expect(mocks.recordOpeningRegister).toHaveBeenCalledWith({
      deviceId: DEV_ID,
      readingKwh: 1234.5,
      readAt: "2026-09-01T00:00:00Z",
    });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it("409 on duplicate evidence", async () => {
    mocks.recordOpeningRegister.mockResolvedValue({
      ok: false,
      status: 409,
      code: "metering_duplicate_reading",
      message: "Already recorded.",
    });
    const { POST } = await import("../route");
    const res = await POST(makePost(BODY));
    expect(res.status).toBe(409);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
