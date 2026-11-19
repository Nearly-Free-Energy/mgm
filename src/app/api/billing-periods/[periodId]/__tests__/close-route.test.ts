import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { parseCloseReview } from "@/lib/billing/close";

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

const CONFIRMED = {
  confirmation: { digest: "v1:reviewed", acknowledged: ["totals_reviewed"], typed: "September 2026" },
};
const REVIEW = parseCloseReview({
  periodId: PERIOD_ID,
  microgridId: MG_ID,
  status: "draft",
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  currency: "UGX",
  billCount: 2,
  totalAmount: 250,
  usageKwh: 3,
  unbilled: [],
  unmetered: [],
  fractionalTotals: [],
  acknowledgements: ["totals_reviewed"],
  digest: "v1:current",
})!;

describe("POST /api/billing-periods/[periodId]/close (issue #5, #201)", () => {
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

  it("200 closes the period with a confirmation and returns the unresolved summary", async () => {
    let received: unknown;
    closeImpl = async (_id, input) => {
      received = input;
      return {
        ok: true,
        data: {
          period: { id: PERIOD_ID, microgrid_id: MG_ID, start_date: "2026-09-01", end_date: "2026-09-30", status: "closed", timezone: "Africa/Kampala" },
          unresolved: [],
        },
      };
    };
    const { POST } = await import("../close/route");
    const res = await POST(post(CONFIRMED), ctx());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { period: { status: string }; unresolved: unknown[] };
    expect(json.period.status).toBe("closed");
    expect(json.unresolved).toEqual([]);
    expect(received).toEqual(CONFIRMED);
  });

  it("428 with the review and its confirmation step when no confirmation is sent", async () => {
    closeImpl = async () => ({
      ok: false,
      status: 428,
      code: "billing_close_confirmation_required",
      message: "Review the totals.",
      review: REVIEW,
    });
    const { POST } = await import("../close/route");
    const res = await POST(post({}), ctx());
    expect(res.status).toBe(428);
    const json = (await res.json()) as { code: string; review: unknown; ok?: unknown; status?: unknown };
    expect(json.code).toBe("billing_close_confirmation_required");
    expect(json.review).toEqual(REVIEW);
    // The host's step for that review, formatted on the server.
    expect((json as { ceremony?: unknown }).ceremony).toMatchObject({
      type: "ceremony",
      digest: "v1:current",
      typed: "September 2026",
      acknowledgements: [{ id: "totals_reviewed" }],
      facts: [{ label: "Period" }, { label: "Bills" }, { label: "Energy" }, { label: "Total", value: { t: "money", currency: "UGX" } }],
    });
    expect(json).not.toHaveProperty("ok");
    expect(json).not.toHaveProperty("status");
  });

  it("409 with the current review when the totals changed after review", async () => {
    closeImpl = async () => ({
      ok: false,
      status: 409,
      code: "billing_period_totals_changed",
      message: "The period's totals changed after you reviewed them.",
      review: REVIEW,
    });
    const { POST } = await import("../close/route");
    const res = await POST(post(CONFIRMED), ctx());
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; review: unknown };
    expect(json.code).toBe("billing_period_totals_changed");
    expect(json.review).toEqual(REVIEW);
    expect((json as { ceremony?: { digest?: string } }).ceremony?.digest).toBe("v1:current");
  });

  it("sends no ceremony with a refusal that carries no review", async () => {
    closeImpl = async () => ({ ok: false, status: 403, code: "billing_scope_mismatch", message: "Not authorized." });
    const { POST } = await import("../close/route");
    const res = await POST(post({}), ctx());
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("ceremony");
  });

  it.each([
    ["the legacy confirmed flag", { confirmed: true }],
    ["a confirmation without a digest", { confirmation: { acknowledged: [] } }],
    ["a body that is not an object", [1]],
    ["a body that is not JSON", "{"],
  ])("400 for %s, before composing billing", async (_label, body) => {
    const compose = vi.fn(composeImpl);
    composeImpl = compose;
    const { POST } = await import("../close/route");
    const res = await POST(post(body), ctx());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
    expect(compose).not.toHaveBeenCalled();
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
