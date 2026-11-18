import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const PERIOD_ID = "770e8400-e29b-41d4-a716-446655440000";
const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";

let periodRow: unknown;
let microgridRow: unknown;
let deleteImpl: (id: string, input: unknown) => Promise<unknown>;
let dispose: ReturnType<typeof vi.fn>;
let composeImpl: (...args: unknown[]) => Promise<unknown>;

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
  composeBilling: (...args: unknown[]) => composeImpl(...args),
}));

function del(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/billing-periods/${PERIOD_ID}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

function ctx() {
  return { params: Promise.resolve({ periodId: PERIOD_ID }) };
}

/** What the GUI host sends once the name is typed. */
const TYPED = { confirmation: { acknowledged: [], typed: "September 2026" } };

describe("DELETE /api/billing-periods/[periodId] (#201)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    periodRow = { id: PERIOD_ID, microgrid_id: MG_ID };
    microgridRow = { id: MG_ID, communities: { org_id: ORG_ID } };
    deleteImpl = async () => ({ ok: true, data: { periodId: PERIOD_ID, microgridId: MG_ID, name: "September 2026" } });
    dispose = vi.fn(async () => {});
    composeImpl = async () => ({
      ok: true,
      data: { billing: { deletePeriod: (id: string, input: unknown) => deleteImpl(id, input) }, dispose },
    });
  });

  it("200 deletes the period and names the list to return to", async () => {
    let received: unknown[] = [];
    deleteImpl = async (...args) => {
      received = args;
      return { ok: true, data: { periodId: PERIOD_ID, microgridId: MG_ID, name: "September 2026" } };
    };
    const compose = vi.fn(composeImpl);
    composeImpl = compose;
    const { DELETE } = await import("../route");
    const res = await DELETE(del(TYPED), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: PERIOD_ID,
      message: "Deleted the draft period September 2026.",
      href: `/microgrids/${MG_ID}/billing`,
    });
    expect(received).toEqual([PERIOD_ID, TYPED]);
    // Composed for the period's organization, without readOnly, so the plugin gate applies.
    expect(compose).toHaveBeenCalledWith({ supabase: expect.anything(), organizationId: ORG_ID });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no body", undefined],
    ["a body that is not JSON", "{"],
    ["a body that is not an object", [1]],
    ["an unknown field", { confirmed: true }],
    ["a digest", { confirmation: { digest: "v1:x", acknowledged: [], typed: "September 2026" } }],
  ])("400 for %s, before composing billing", async (_label, body) => {
    const compose = vi.fn(composeImpl);
    composeImpl = compose;
    const { DELETE } = await import("../route");
    const res = await DELETE(del(body), ctx());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
    expect(compose).not.toHaveBeenCalled();
  });

  it.each([
    ["the period", () => (periodRow = null)],
    ["its microgrid", () => (microgridRow = null)],
  ])("404 when row-level security hides %s, before composing billing", async (_label, hide) => {
    hide();
    const compose = vi.fn(composeImpl);
    composeImpl = compose;
    const { DELETE } = await import("../route");
    const res = await DELETE(del(TYPED), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Billing period not found.", code: "billing_period_not_found" });
    expect(compose).not.toHaveBeenCalled();
  });

  it("passes a composition failure through (billing disabled)", async () => {
    composeImpl = async () => ({ ok: false, status: 409, code: "billing_disabled", message: "Billing is disabled." });
    const { DELETE } = await import("../route");
    const res = await DELETE(del(TYPED), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "billing_disabled", message: "Billing is disabled." });
  });

  it.each([
    [428, { code: "billing_delete_confirmation_required", message: "Type the period's name, September 2026, to delete it." }],
    [
      428,
      { code: "billing_delete_name_mismatch", message: "Type the period's name, September 2026, to delete it.", field: "confirmation" },
    ],
    [409, { code: "billing_period_kept", message: "This period is closed, so it is kept as the billing record and cannot be deleted." }],
  ])("passes the capability's %i through, and disposes", async (status, body) => {
    deleteImpl = async () => ({ ok: false, status, ...body });
    const { DELETE } = await import("../route");
    const res = await DELETE(del({}), ctx());
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json).toEqual(body);
    expect(json).not.toHaveProperty("ok");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes when the capability throws", async () => {
    deleteImpl = async () => {
      throw new Error("boom");
    };
    const { DELETE } = await import("../route");
    await expect(DELETE(del(TYPED), ctx())).rejects.toThrow("boom");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
