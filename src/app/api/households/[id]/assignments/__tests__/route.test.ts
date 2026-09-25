import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  compose: vi.fn(),
  dispose: vi.fn(),
  getAssignmentHistory: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/metering/compose", () => ({
  composeMetering: (...args: unknown[]) => mocks.compose(...args),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mocks.from }),
}));

const HH_ID = "660e8400-e29b-41d4-a716-446655440010";
const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const ORG_ID = "660e8400-e29b-41d4-a716-446655440099";

function wireFound() {
  mocks.from.mockImplementation((table: string) => {
    if (table === "households") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: HH_ID, microgrid_id: MG_ID },
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
}

function makeGet(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/households/${id}/assignments`);
}

describe("GET household assignments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireFound();
    mocks.compose.mockResolvedValue({
      ok: true,
      data: {
        metering: { getAssignmentHistory: mocks.getAssignmentHistory },
        dispose: mocks.dispose,
      },
    });
  });

  it("400 on malformed household id", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeGet("bad"), {
      params: Promise.resolve({ id: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when the household is hidden or missing", async () => {
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }));
    const { GET } = await import("../route");
    const res = await GET(makeGet(HH_ID), {
      params: Promise.resolve({ id: HH_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("returns entries and gaps, then disposes", async () => {
    const history = {
      entries: [
        {
          deviceId: "dev-1",
          deviceName: "Meter 01",
          role: "primary_consumption_meter",
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-03-01",
          current: false,
        },
      ],
      gaps: [{ from: "2026-03-01", to: "2026-04-01" }],
    };
    mocks.getAssignmentHistory.mockResolvedValue({ ok: true, data: history });
    const { GET } = await import("../route");
    const res = await GET(makeGet(HH_ID), {
      params: Promise.resolve({ id: HH_ID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(history);
    expect(mocks.getAssignmentHistory).toHaveBeenCalledWith(HH_ID);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
