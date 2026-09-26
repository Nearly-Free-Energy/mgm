import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const PERIOD_ID = "770e8400-e29b-41d4-a716-446655440000";

let microgridRow: unknown = { id: MG_ID, communities: { org_id: "550e8400-e29b-41d4-a716-446655440000" } };
let createPeriodImpl: (input: unknown) => Promise<unknown> = async () => ({
  ok: true,
  data: {
    id: PERIOD_ID,
    microgrid_id: MG_ID,
    start_date: "2026-09-01",
    end_date: "2026-09-30",
    status: "draft",
    timezone: "Africa/Kampala",
  },
});
let composeImpl: () => Promise<unknown> = async () => ({
  ok: true,
  data: {
    billing: { createPeriod: createPeriodImpl },
    dispose: async () => {},
  },
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: microgridRow, error: null }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/billing/compose", () => ({
  composeBilling: (...args: unknown[]) => (composeImpl as (...a: unknown[]) => Promise<unknown>)(...args),
}));

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/billing-periods", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/billing-periods (issue #5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    microgridRow = { id: MG_ID, communities: { org_id: "550e8400-e29b-41d4-a716-446655440000" } };
    createPeriodImpl = async () => ({
      ok: true,
      data: {
        id: PERIOD_ID,
        microgrid_id: MG_ID,
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        status: "draft",
        timezone: "Africa/Kampala",
      },
    });
    composeImpl = async () => ({
      ok: true,
      data: { billing: { createPeriod: createPeriodImpl }, dispose: async () => {} },
    });
  });

  it("404 when the microgrid is unknown", async () => {
    microgridRow = null;
    const { POST } = await import("../route");
    const res = await POST(
      post({ microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-09-30" })
    );
    expect(res.status).toBe(404);
  });

  it("201 with the stamped period on success", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      post({ microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-09-30" })
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { period: { timezone: string } };
    expect(json.period.timezone).toBe("Africa/Kampala");
  });

  it("maps composition failures (e.g. billing disabled)", async () => {
    composeImpl = async () => ({
      ok: false,
      status: 409,
      code: "billing_disabled",
      message: "Billing is disabled.",
    });
    const { POST } = await import("../route");
    const res = await POST(
      post({ microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-09-30" })
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("billing_disabled");
  });

  it("maps capability validation errors", async () => {
    createPeriodImpl = async () => ({
      ok: false,
      status: 422,
      code: "billing_invalid_range",
      message: "start_date and end_date must be YYYY-MM-DD with start_date <= end_date.",
    });
    const { POST } = await import("../route");
    const res = await POST(
      post({ microgrid_id: MG_ID, start_date: "2026-09-30", end_date: "2026-09-01" })
    );
    expect(res.status).toBe(422);
  });
});
