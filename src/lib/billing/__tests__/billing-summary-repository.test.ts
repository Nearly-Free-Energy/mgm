import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBillingRepository } from "../infrastructure/supabase-repository";

const period = { id: "period", microgrid_id: "grid", status: "draft" };
function repository(failedTable?: string, missingTable?: string) {
  const client = { from: (table: string) => ({ select: () => ({ eq: () => {
    const result = {
      data: table === missingTable || table === failedTable ? null : table === "billing_periods" ? period : [],
      error: table === failedTable ? { message: "database unavailable", code: "XX000" } : null,
    };
    return table === "billing_periods" ? { maybeSingle: async () => result } : Promise.resolve(result);
  } }) }) };
  return createSupabaseBillingRepository(client as unknown as SupabaseClient);
}
describe("billing summary read failures", () => {
  it.each(["billing_periods", "tenants", "billing_line_items"])("rejects failed %s reads", async (table) => {
    await expect(repository(table).getPeriodSummary("period")).rejects.toThrow();
  });
  it.each(["tenants", "billing_line_items"])("rejects missing %s results", async (table) => {
    await expect(repository(undefined, table).getPeriodSummary("period")).rejects.toThrow();
  });
  it("retains a valid empty-period summary", async () => {
    expect(await repository().getPeriodSummary("period")).toMatchObject({ lineItemCount: 0, totalAmount: 0, unresolved: [] });
  });
  it("distinguishes a missing period from query failure", async () => {
    expect(await repository(undefined, "billing_periods").getPeriodSummary("period")).toBeNull();
  });
});

describe("manual payment notes RPC contract", () => {
  it.each([ ["paid", "receipt", { payment_notes: "receipt" }], ["unpaid", null, { payment_notes: null }], ["paid", null, {}] ] as const)("maps %s notes %s", async (status, notes, payload) => {
    const rpc = vi.fn(async () => ({ data: {}, error: null }));
    const repo = createSupabaseBillingRepository({ rpc } as unknown as SupabaseClient);
    await repo.recordManualPayment({ lineItemId: "item", actorUserId: "user", status, notes });
    expect(rpc).toHaveBeenCalledWith("fn_apply_payment_event", expect.objectContaining({ _raw_payload: { ...payload, recorded_via: "mgm-billing" } }));
  });
});

describe("deleting a billing period (#201)", () => {
  function deleting(result: { data: unknown; error: unknown }) {
    const calls: [string, unknown[]][] = [];
    const client = { rpc: async (...a: unknown[]) => (calls.push(["rpc", a]), result) };
    return { repo: createSupabaseBillingRepository(client as unknown as SupabaseClient), calls };
  }

  it("deletes through fn_delete_draft_billing_period, which returns the deleted id or null", async () => {
    const done = deleting({ data: "period", error: null });
    expect(await done.repo.deleteBillingPeriod("period")).toEqual({ deleted: true, error: null });
    expect(done.calls).toEqual([["rpc", ["fn_delete_draft_billing_period", { _period_id: "period" }]]]);
    // NULL: no such period, or not the caller's to delete.
    expect(await deleting({ data: null, error: null }).repo.deleteBillingPeriod("period")).toEqual({ deleted: false, error: null });
    expect(await deleting({ data: "another", error: null }).repo.deleteBillingPeriod("period")).toEqual({ deleted: false, error: null });
  });

  it("keeps the delete guard's DETAIL, which names why the period is kept", async () => {
    const { repo } = deleting({ data: null, error: { code: "23514", message: "billing_period_kept", details: "payment_activity" } });
    expect(await repo.deleteBillingPeriod("period")).toEqual({
      deleted: false,
      error: { code: "23514", message: "billing_period_kept", details: "payment_activity" },
    });
    expect(await deleting({ data: null, error: { code: "23503", message: "fk" } }).repo.deleteBillingPeriod("period")).toEqual({
      deleted: false,
      error: { code: "23503", message: "fk", details: null },
    });
  });

  it("reads the period, and rejects a failed read", async () => {
    expect(await repository().getBillingPeriod("period")).toEqual(period);
    expect(await repository(undefined, "billing_periods").getBillingPeriod("period")).toBeNull();
    await expect(repository("billing_periods").getBillingPeriod("period")).rejects.toThrow();
  });
});
