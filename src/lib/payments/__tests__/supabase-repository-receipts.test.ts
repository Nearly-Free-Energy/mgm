/**
 * A failed read of an attempt's receipts throws, as the attempts read does,
 * so listHistory's received total and difference are never built from a
 * read that failed as if there were no receipts.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabasePaymentsRepository } from "../infrastructure/supabase-repository";

const ATTEMPT = "66666666-6666-6666-6666-666666666666";

function client(answer: { data: unknown[] | null; error: { message: string } | null }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: async () => answer,
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe("the Supabase payments repository's receipts read", () => {
  it("returns the receipts it reads", async () => {
    const c = client({ data: [{ id: "r1", attempt_id: ATTEMPT }], error: null });
    expect(await createSupabasePaymentsRepository(c, c).listReceiptsForAttempt(ATTEMPT)).toEqual([{ id: "r1", attempt_id: ATTEMPT }]);
  });

  it("throws a fixed message when the read fails, never the database's", async () => {
    const c = client({ data: null, error: { message: "secret database detail" } });
    await expect(createSupabasePaymentsRepository(c, c).listReceiptsForAttempt(ATTEMPT)).rejects.toThrow("Could not load payment receipts");
  });
});
