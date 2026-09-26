import { describe, expect, it, vi } from "vitest";
import {
  billingDisabledResponse,
  billingWriteGateForCommunity,
  billingWriteGateForLineItem,
  billingWriteGateForMicrogrid,
  billingWriteGateForPeriod,
  billingWriteGateForRateSchedule,
} from "../guard";

const MG_ID = "660e8400-e29b-41d4-a716-446655440000";
const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";
const PERIOD_ID = "770e8400-e29b-41d4-a716-446655440000";
const ITEM_ID = "880e8400-e29b-41d4-a716-446655440000";
const COMM_ID = "990e8400-e29b-41d4-a716-446655440000";
const RS_ID = "aa0e8400-e29b-41d4-a716-446655440000";

function chain(result: unknown) {
  // PostgREST chain: from().select().eq().maybeSingle()
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: result, error: null }),
        }),
      }),
    }),
  };
}

function makeSupabase(row: unknown, enabled: boolean) {
  return {
    ...chain(row),
    rpc: async () => ({ data: enabled, error: null }),
  } as never;
}

describe("billing write gates", () => {
  it("returns the 409 disabled payload", () => {
    const res = billingDisabledResponse();
    expect(res.status).toBe(409);
  });

  it("microgrid: 409 when disabled, null when enabled", async () => {
    const row = { id: MG_ID, communities: { org_id: ORG_ID } };
    const blocked = await billingWriteGateForMicrogrid(makeSupabase(row, false), MG_ID);
    expect(blocked?.status).toBe(409);

    const allowed = await billingWriteGateForMicrogrid(makeSupabase(row, true), MG_ID);
    expect(allowed).toBeNull();
  });

  it("microgrid: null when the organization cannot be resolved", async () => {
    const allowed = await billingWriteGateForMicrogrid(makeSupabase(null, false), MG_ID);
    expect(allowed).toBeNull();
  });

  it("microgrid: null for unstubbed mock clients (existing route tests)", async () => {
    const allowed = await billingWriteGateForMicrogrid({ from: vi.fn() } as never, MG_ID);
    expect(allowed).toBeNull();
  });

  it("period: resolves through the period row and gates", async () => {
    const supabase = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === "billing_periods"
                ? { data: { id: PERIOD_ID, microgrid_id: MG_ID }, error: null }
                : { data: { id: MG_ID, communities: { org_id: ORG_ID } }, error: null },
          }),
        }),
      }),
      rpc: async () => ({ data: false, error: null }),
    } as never;
    const blocked = await billingWriteGateForPeriod(supabase, PERIOD_ID);
    expect(blocked?.status).toBe(409);
  });

  it("line item: resolves through item → period → microgrid and gates", async () => {
    const supabase = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (table === "billing_line_items") {
                return { data: { id: ITEM_ID, billing_period_id: PERIOD_ID }, error: null };
              }
              if (table === "billing_periods") {
                return { data: { id: PERIOD_ID, microgrid_id: MG_ID }, error: null };
              }
              return { data: { id: MG_ID, communities: { org_id: ORG_ID } }, error: null };
            },
          }),
        }),
      }),
      rpc: async () => ({ data: false, error: null }),
    } as never;
    const blocked = await billingWriteGateForLineItem(supabase, ITEM_ID);
    expect(blocked?.status).toBe(409);
  });

  it("rate schedule: resolves through the schedule row and gates", async () => {
    const supabase = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === "rate_schedules"
                ? { data: { id: RS_ID, microgrid_id: MG_ID }, error: null }
                : { data: { id: MG_ID, communities: { org_id: ORG_ID } }, error: null },
          }),
        }),
      }),
      rpc: async () => ({ data: false, error: null }),
    } as never;
    const blocked = await billingWriteGateForRateSchedule(supabase, RS_ID);
    expect(blocked?.status).toBe(409);
  });

  it("community: 409 when disabled, null when enabled", async () => {
    const row = { id: COMM_ID, org_id: ORG_ID };
    const blocked = await billingWriteGateForCommunity(makeSupabase(row, false), COMM_ID);
    expect(blocked?.status).toBe(409);

    const allowed = await billingWriteGateForCommunity(makeSupabase(row, true), COMM_ID);
    expect(allowed).toBeNull();
  });
});
