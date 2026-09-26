import { describe, expect, it } from "vitest";
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
  it.each(["billing_periods", "households", "billing_line_items"])("rejects failed %s reads", async (table) => {
    await expect(repository(table).getPeriodSummary("period")).rejects.toThrow();
  });
  it.each(["households", "billing_line_items"])("rejects missing %s results", async (table) => {
    await expect(repository(undefined, table).getPeriodSummary("period")).rejects.toThrow();
  });
  it("retains a valid empty-period summary", async () => {
    expect(await repository().getPeriodSummary("period")).toMatchObject({ lineItemCount: 0, totalAmount: 0, unresolved: [] });
  });
  it("distinguishes a missing period from query failure", async () => {
    expect(await repository(undefined, "billing_periods").getPeriodSummary("period")).toBeNull();
  });
});
