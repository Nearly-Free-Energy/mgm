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

  it("maps capability errors", async () => {
    createPeriodImpl = async () => ({
      ok: false,
      status: 409,
      code: "billing_period_overlap",
      message: "This billing period overlaps an existing period for the microgrid.",
    });
    const { POST } = await import("../route");
    const res = await POST(
      post({ microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-09-30" })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "billing_period_overlap" });
  });

  it("passes the capability only the parsed fields", async () => {
    const createPeriod = vi.fn(createPeriodImpl);
    composeImpl = async () => ({ ok: true, data: { billing: { createPeriod }, dispose: async () => {} } });
    const { POST } = await import("../route");
    await POST(post({ microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-09-01" }));
    expect(createPeriod).toHaveBeenCalledWith({ microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-09-01" });
  });

  it.each([
    [
      "an inverted range",
      { microgrid_id: MG_ID, start_date: "2026-09-30", end_date: "2026-09-01" },
      "start_date and end_date must be YYYY-MM-DD with start_date <= end_date.",
      "start_date",
    ],
    [
      "a day that does not exist",
      { microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-02-30" },
      "start_date and end_date must be YYYY-MM-DD with start_date <= end_date.",
      "end_date",
    ],
    ["a missing microgrid", { start_date: "2026-09-01", end_date: "2026-09-30" }, "microgrid_id must be a valid UUID.", "microgrid_id"],
    [
      "an unknown key",
      { microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-09-30", timezone: "UTC" },
      "Unknown field: timezone",
      undefined,
    ],
    ["a null body", null, "Request body must be an object", undefined],
  ])("400 invalid_body for %s, before the lookup and the composer", async (_label, body, error, field) => {
    const compose = vi.fn(composeImpl);
    composeImpl = compose;
    microgridRow = null;
    const { POST } = await import("../route");
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error, ...(field ? { field } : {}), code: "invalid_body" });
    expect(compose).not.toHaveBeenCalled();
  });

  it("400 invalid_body for a body that is not JSON", async () => {
    const { POST } = await import("../route");
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body", code: "invalid_body" });
  });
});
