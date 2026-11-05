/**
 * The checkout path's tracking writes and every status write must leave an
 * attempt that another request already closed exactly as it is: a request
 * that outlived the supersede window may not hand out a second checkout URL
 * or reopen a superseded attempt.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabasePaymentsRepository } from "../infrastructure/supabase-repository";
import { ATTEMPT_NOT_OPEN } from "../repository";

const ATTEMPT = "66666666-6666-6666-6666-666666666666";

/** A client recording the update's payload and filters, answering `answer` to select(). */
function recordingClient(answer: { data: unknown[] | null; error: { message: string } | null }) {
  const calls: { table?: string; payload?: unknown; filters: unknown[][]; selected?: string } = { filters: [] };
  const builder = {
    update(payload: unknown) { calls.payload = payload; return builder; },
    eq(...args: unknown[]) { calls.filters.push(["eq", ...args]); return builder; },
    in(...args: unknown[]) { calls.filters.push(["in", ...args]); return builder; },
    async select(columns: string) { calls.selected = columns; return answer; },
  };
  const client = { from(table: string) { calls.table = table; return builder; } } as unknown as SupabaseClient;
  return { client, calls };
}

describe("the Supabase payments repository's attempt writes", () => {
  it("writes tracking with requireOpen only while the attempt is pending or confirmation pending", async () => {
    const { client, calls } = recordingClient({ data: [{ id: ATTEMPT }], error: null });
    const error = await createSupabasePaymentsRepository(client, client).updateAttemptTracking({
      attemptId: ATTEMPT, providerTrackingId: "TRACK-1", checkoutUrl: "https://pay.example/checkout", requireOpen: true,
    });
    expect(error).toBeNull();
    expect(calls.payload).toEqual({ provider_tracking_id: "TRACK-1", checkout_url: "https://pay.example/checkout" });
    expect(calls.filters).toEqual([
      ["eq", "id", ATTEMPT],
      ["in", "status", ["pending", "confirmation_pending"]],
    ]);
    expect(calls.selected).toBe("id");
  });

  it("reports ATTEMPT_NOT_OPEN when requireOpen finds no open attempt", async () => {
    const { client } = recordingClient({ data: [], error: null });
    const error = await createSupabasePaymentsRepository(client, client).updateAttemptTracking({
      attemptId: ATTEMPT, providerTrackingId: "TRACK-1", requireOpen: true,
    });
    expect(error).toEqual({ code: ATTEMPT_NOT_OPEN, message: expect.any(String) });
  });

  it("passes a write error back with requireOpen", async () => {
    const { client } = recordingClient({ data: null, error: { message: "write failed" } });
    const error = await createSupabasePaymentsRepository(client, client).updateAttemptTracking({
      attemptId: ATTEMPT, providerTrackingId: "TRACK-1", requireOpen: true,
    });
    expect(error).toMatchObject({ message: "write failed" });
    expect(error?.code).not.toBe(ATTEMPT_NOT_OPEN);
  });

  it("leaves the status filter off without requireOpen, as the notification path binds verified tracking", async () => {
    const { client, calls } = recordingClient({ data: [], error: null });
    const error = await createSupabasePaymentsRepository(client, client).updateAttemptTracking({
      attemptId: ATTEMPT, providerTrackingId: "TRACK-1", checkoutUrl: "",
    });
    expect(error).toBeNull();
    expect(calls.filters).toEqual([["eq", "id", ATTEMPT]]);
    expect(calls.selected).toBeUndefined();
  });

  it("changes the status of an open attempt only", async () => {
    const { client, calls } = recordingClient({ data: [], error: null });
    await createSupabasePaymentsRepository(client, client).markAttemptStatus({
      attemptId: ATTEMPT, status: "confirmation_pending", failureCode: "confirmation_pending", failureMessage: "held",
    });
    expect(calls.payload).toEqual({ status: "confirmation_pending", failure_code: "confirmation_pending", failure_message: "held" });
    expect(calls.filters).toEqual([
      ["eq", "id", ATTEMPT],
      ["in", "status", ["pending", "confirmation_pending"]],
    ]);
  });
});
