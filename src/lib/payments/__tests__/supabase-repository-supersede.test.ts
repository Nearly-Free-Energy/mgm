/**
 * `failUnlinkedAttempt` must narrow its update to an attempt that is still
 * open and still has neither a tracking ID nor a checkout URL, so a request
 * that linked the attempt after it was read is never overwritten.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabasePaymentsRepository } from "../infrastructure/supabase-repository";

const ATTEMPT = "66666666-6666-6666-6666-666666666666";

/** A client recording the update's payload and filters, answering `rows`. */
function recordingClient(answer: { data: unknown[] | null; error: { message: string } | null }) {
  const calls: { table?: string; payload?: unknown; filters: unknown[][]; selected?: string } = { filters: [] };
  const builder = {
    update(payload: unknown) { calls.payload = payload; return builder; },
    eq(...args: unknown[]) { calls.filters.push(["eq", ...args]); return builder; },
    in(...args: unknown[]) { calls.filters.push(["in", ...args]); return builder; },
    is(...args: unknown[]) { calls.filters.push(["is", ...args]); return builder; },
    async select(columns: string) { calls.selected = columns; return answer; },
  };
  const client = { from(table: string) { calls.table = table; return builder; } } as unknown as SupabaseClient;
  return { client, calls };
}

describe("the Supabase payments repository's failUnlinkedAttempt", () => {
  it("fails only an open attempt with no tracking ID and no checkout URL", async () => {
    const { client, calls } = recordingClient({ data: [{ id: ATTEMPT }], error: null });
    const result = await createSupabasePaymentsRepository(client, client).failUnlinkedAttempt({
      attemptId: ATTEMPT, failureCode: "checkout_superseded", failureMessage: "replaced",
    });
    expect(result).toEqual({ failed: true, error: null });
    expect(calls.table).toBe("payment_attempts");
    expect(calls.payload).toEqual({ status: "failed", failure_code: "checkout_superseded", failure_message: "replaced" });
    expect(calls.filters).toEqual([
      ["eq", "id", ATTEMPT],
      ["in", "status", ["pending", "confirmation_pending"]],
      ["is", "provider_tracking_id", null],
      ["is", "checkout_url", null],
    ]);
  });

  it("reports nothing failed when no row still matches", async () => {
    const { client } = recordingClient({ data: [], error: null });
    expect(
      await createSupabasePaymentsRepository(client, client).failUnlinkedAttempt({
        attemptId: ATTEMPT, failureCode: "checkout_superseded", failureMessage: "replaced",
      })
    ).toEqual({ failed: false, error: null });
  });

  it("passes a write error back", async () => {
    const { client } = recordingClient({ data: null, error: { message: "write failed" } });
    const result = await createSupabasePaymentsRepository(client, client).failUnlinkedAttempt({
      attemptId: ATTEMPT, failureCode: "checkout_superseded", failureMessage: "replaced",
    });
    expect(result.failed).toBe(false);
    expect(result.error).not.toBeNull();
  });
});
