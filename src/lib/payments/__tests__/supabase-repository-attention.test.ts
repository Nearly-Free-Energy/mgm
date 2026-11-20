/**
 * The attention read: the organization's attempts in one status, through
 * the person's own client (never the writer), changed since an instant when
 * given, without the excepted failure codes but keeping an attempt with no
 * code; only the columns listAttention returns; a failed read throws a
 * fixed message.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabasePaymentsRepository } from "../infrastructure/supabase-repository";

const ORG = "11111111-1111-1111-1111-111111111111";

function client(answer: { data: unknown[] | null; error: { message: string } | null }) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {
    then: (resolve: (r: typeof answer) => unknown) => Promise.resolve(answer).then(resolve),
  };
  for (const op of ["select", "eq", "gte", "or", "order", "limit"]) {
    builder[op] = (...args: unknown[]) => (calls.push([op, args]), builder);
  }
  const from = (table: string) => (calls.push(["from", [table]]), builder);
  return { client: { from } as unknown as SupabaseClient, calls };
}
const refuse = { from: () => { throw new Error("the writer was used"); } } as unknown as SupabaseClient;

describe("the Supabase payments repository's attention read", () => {
  it("reads the organization's failures since an instant, keeping an attempt with no failure code", async () => {
    const { client: c, calls } = client({
      data: [{ id: "a1", line_item_id: "b1", status: "failed", failure_code: "provider_failed", updated_at: "2026-11-19T08:00:00+00:00" }],
      error: null,
    });
    const out = await createSupabasePaymentsRepository(c, refuse).listAttentionAttempts({
      orgId: ORG,
      status: "failed",
      since: "2026-11-13T09:00:00.000Z",
      exceptFailureCodes: ["checkout_superseded", "checkout_not_submitted"],
      limit: 501,
    });
    expect(out).toEqual([{ id: "a1", lineItemId: "b1", status: "failed", failureCode: "provider_failed", updatedAt: "2026-11-19T08:00:00+00:00" }]);
    expect(calls).toEqual([
      ["from", ["payment_attempts"]],
      ["select", ["id, line_item_id, status, failure_code, updated_at"]],
      ["eq", ["org_id", ORG]],
      ["eq", ["status", "failed"]],
      ["gte", ["updated_at", "2026-11-13T09:00:00.000Z"]],
      ["or", ["failure_code.is.null,failure_code.not.in.(checkout_superseded,checkout_not_submitted)"]],
      ["order", ["updated_at", { ascending: false }]],
      ["order", ["id", { ascending: true }]],
      ["limit", [501]],
    ]);
  });

  it("reads attempts needing reconciliation with no time or code filter", async () => {
    const { client: c, calls } = client({ data: [], error: null });
    await createSupabasePaymentsRepository(c, refuse).listAttentionAttempts({ orgId: ORG, status: "needs_reconciliation", limit: 501 });
    expect(calls.map(([op]) => op)).toEqual(["from", "select", "eq", "eq", "order", "order", "limit"]);
  });

  it("throws a fixed message when the read fails, never the database's", async () => {
    const { client: c } = client({ data: null, error: { message: "secret database detail" } });
    await expect(
      createSupabasePaymentsRepository(c, refuse).listAttentionAttempts({ orgId: ORG, status: "needs_reconciliation", limit: 501 }),
    ).rejects.toThrow("Could not load payment attempts");
  });
});
