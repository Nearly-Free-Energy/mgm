import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const PERIOD_ID = "770e8400-e29b-41d4-a716-446655440000";

let periodRow: unknown = { id: PERIOD_ID, microgrid_id: MG_ID };
let microgridRow: unknown = { id: MG_ID, communities: { org_id: "550e8400-e29b-41d4-a716-446655440000" } };
let closeImpl: (id: string, input: unknown) => Promise<unknown> = async () => ({
  ok: true,
  data: {
    period: {
      id: PERIOD_ID,
      microgrid_id: MG_ID,
      start_date: "2026-09-01",
      end_date: "2026-09-30",
      status: "closed",
      timezone: "Africa/Kampala",
    },
    unresolved: [],
  },
});
let composeImpl: () => Promise<unknown> = async () => ({
  ok: true,
  data: {
    billing: { closePeriod: closeImpl },
    dispose: async () => {},
  },
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: table === "billing_periods" ? periodRow : microgridRow,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/billing/compose", () => ({
  composeBilling: (...args: unknown[]) => (composeImpl as (...a: unknown[]) => Promise<unknown>)(...args),
}));

function post(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/billing-periods/${PERIOD_ID}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx() {
  return { params: Promise.resolve({ periodId: PERIOD_ID }) };
}

describe("POST /api/billing-periods/[periodId]/close (issue #5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    periodRow = { id: PERIOD_ID, microgrid_id: MG_ID };
    microgridRow = { id: MG_ID, communities: { org_id: "550e8400-e29b-41d4-a716-446655440000" } };
    closeImpl = async () => ({
      ok: true,
      data: {
        period: {
          id: PERIOD_ID,
          microgrid_id: MG_ID,
          start_date: "2026-09-01",
          end_date: "2026-09-30",
          status: "closed",
          timezone: "Africa/Kampala",
        },
        unresolved: [],
      },
    });
    composeImpl = async () => ({
      ok: true,
      data: { billing: { closePeriod: closeImpl }, dispose: async () => {} },
    });
  });

  it("404 when the period is unknown", async () => {
    periodRow = null;
    const { POST } = await import("../close/route");
    const res = await POST(post({}), ctx());
    expect(res.status).toBe(404);
  });

  it("200 closes the period and returns the unresolved summary", async () => {
    const { POST } = await import("../close/route");
    const res = await POST(post({ confirmed: true }), ctx());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { period: { status: string }; unresolved: unknown[] };
    expect(json.period.status).toBe("closed");
    expect(json.unresolved).toEqual([]);
  });

  it("409 surfaces unresolved households until confirmed", async () => {
    closeImpl = async () => ({
      ok: false,
      status: 409,
      code: "billing_unresolved_households",
      message: "Period has 1 unresolved household(s).",
    });
    const { POST } = await import("../close/route");
    const res = await POST(post({}), ctx());
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("billing_unresolved_households");
  });

  it("maps composition failures (e.g. billing disabled)", async () => {
    composeImpl = async () => ({
      ok: false,
      status: 409,
      code: "billing_disabled",
      message: "Billing is disabled.",
    });
    const { POST } = await import("../close/route");
    const res = await POST(post({}), ctx());
    expect(res.status).toBe(409);
  });
});
