/**
 * generate-timezone.test.ts (#355)
 *
 * `runGenerationFor` must pass the billing period's STAMPED timezone
 * (`billing_periods.timezone`, written once by #354's BEFORE INSERT trigger)
 * into `DeviceDataAdapter.getReadings` — never `microgrids.timezone`, which
 * an operator can change after periods exist.
 *
 * Two properties are pinned here:
 *
 *   1. Period-wins: with microgrid tz ≠ period tz, the PERIOD's value reaches
 *      the adapter. The mocked microgrid row deliberately carries a different
 *      timezone so a mutation that re-reads `microgrids.timezone` produces a
 *      visibly wrong value instead of a coincidental pass.
 *
 *   2. Immutability / regression guard: a CLOSED period stamped "UTC",
 *      regenerated after its microgrid is switched to Africa/Kampala, issues
 *      the byte-identical adapter call (same window params) and produces
 *      byte-identical line-item results. The trigger only fires on INSERT,
 *      regeneration never re-stamps — so nothing about the output may move.
 *
 * Harness: same fully-mocked Supabase pattern as
 * `generate-unmetered-skip.test.ts` (runs under SKIP_RLS_TESTS=1), plus
 * mocked `@/lib/openems` / `@/lib/openems/config` so the adapter call's
 * arguments can be captured without a network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runGenerationFor, isRunGenerationFatal } from "@/lib/billing/generate";
import type { MeteringReadRequest } from "@/lib/metering/types";

const MICROGRID_ID = "aaaaaaaa-aaaa-4000-8000-000000000355";
const PERIOD_ID = "aaaaaaaa-aaaa-4000-8006-000000000355";
const HH_METERED = "aaaaaaaa-aaaa-4000-8005-000000000355";
const DEVICE_ID = "aaaaaaaa-aaaa-4000-8004-000000000355";

// Captured provider-neutral requests, one per metering invocation. Reset in
// beforeEach. Billing's contract is deliberately independent of OpenEMS.
const getReadingsCalls: MeteringReadRequest[] = [];
const meteringProvider = {
  getReadings: async (request: MeteringReadRequest) => {
    getReadingsCalls.push(request);
    return request.devices.map((device) => ({
      deviceId: device.id,
      usageKwh: 178.35,
      startDate: request.startDate,
      endDate: request.endDate,
    }));
  },
};

/**
 * Minimal chainable + thenable Supabase stub (same shape as
 * generate-unmetered-skip.test.ts), parameterised by the period's stamped
 * timezone and the microgrid's CURRENT timezone. The microgrid row is served
 * even though the correct implementation never asks for it — that asymmetry
 * is what makes the period-wins assertion mutation-robust.
 */
function makeSupabase(opts: {
  periodTimezone: string;
  microgridTimezone: string;
  periodStatus?: string;
}) {
  const rpc = vi.fn(async () => ({ data: null, error: null }));

  const responses: Record<
    string,
    { single?: unknown; maybeSingle?: unknown; list?: unknown }
  > = {
    billing_periods: {
      single: {
        data: {
          id: PERIOD_ID,
          microgrid_id: MICROGRID_ID,
          start_date: "2026-04-01",
          end_date: "2026-04-30",
          status: opts.periodStatus ?? "draft",
          timezone: opts.periodTimezone,
        },
        error: null,
      },
      // Prior-period lookup for start_kwh derivation → none.
      list: { data: [], error: null },
    },
    microgrids: {
      single: {
        data: {
          id: MICROGRID_ID,
          timezone: opts.microgridTimezone,
        },
        error: null,
      },
      list: {
        data: [{ id: MICROGRID_ID, timezone: opts.microgridTimezone }],
        error: null,
      },
    },
    rate_schedules: {
      maybeSingle: {
        data: {
          microgrid_id: MICROGRID_ID,
          tiers: [
            { label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 100 },
          ],
          service_charge: 0,
          tax_rate: 0,
        },
        error: null,
      },
    },
    households: {
      // One EDGE-METERED household — forces the OpenEMS path.
      list: {
        data: [
          {
            id: HH_METERED,
            display_name: "Metered Household",
            household_devices: [
              {
                role: "primary_consumption_meter",
                effective_from: "2020-01-01",
                effective_to: null,
                devices: {
                  id: DEVICE_ID,
                  openems_component_id: "meter0",
                  edges: { openems_edge_id: "edge0" },
                },
              },
            ],
          },
        ],
        error: null,
      },
    },
    billing_line_items: {
      list: { data: [], error: null },
    },
  };

  function builder(table: string) {
    const resp = responses[table] ?? { list: { data: [], error: null } };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of [
      "select",
      "eq",
      "neq",
      "lte",
      "gte",
      "in",
      "not",
      "order",
      "limit",
    ]) {
      b[m] = chain;
    }
    b.single = async () => resp.single ?? { data: null, error: null };
    b.maybeSingle = async () => resp.maybeSingle ?? { data: null, error: null };
    b.then = (
      onFulfilled: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown
    ) =>
      Promise.resolve(resp.list ?? { data: [], error: null }).then(
        onFulfilled,
        onRejected
      );
    return b;
  }

  const supabase = {
    from: (table: string) => builder(table),
    rpc,
  } as unknown as SupabaseClient;

  return { supabase, rpc };
}

async function generatePreview(supabase: SupabaseClient) {
  const out = await runGenerationFor({
    supabase,
    periodId: PERIOD_ID,
    householdIds: undefined,
    mode: "preview",
    actorUserId: null,
    // No prior end_kwh in the mocked DB → supply a seed so the metered
    // household resolves a start reading (#339) and the OpenEMS path runs.
    seedReadings: [
      {
        deviceId: DEVICE_ID,
        dialReadingKwh: 1000,
        readAt: "2026-04-01T09:00:00Z",
        startKwh: 1000,
      },
    ],
    meteringProvider,
  });
  if (isRunGenerationFatal(out)) {
    throw new Error(
      `runGenerationFor returned fatal ${out.status}: ${JSON.stringify(out.body)}`
    );
  }
  return out;
}

beforeEach(() => {
  getReadingsCalls.length = 0;
});

describe("runGenerationFor: period-stamped timezone threading (#355)", () => {
  it("passes billingPeriod.timezone to getReadings — the period's value wins over the microgrid's", async () => {
    const { supabase } = makeSupabase({
      periodTimezone: "Pacific/Auckland",
      microgridTimezone: "Africa/Kampala", // ≠ period tz, on purpose
    });

    const out = await generatePreview(supabase);

    expect(getReadingsCalls).toHaveLength(1);
    const meteringRequest = getReadingsCalls[0];
    expect(meteringRequest.devices.map((d) => d.id)).toEqual([DEVICE_ID]);
    expect(meteringRequest.startDate).toBe("2026-04-01");
    expect(meteringRequest.endDate).toBe("2026-04-30");
    // The stamped value, verbatim. "Africa/Kampala" here means the code
    // re-read the microgrid's current timezone — the exact bug this pins.
    expect(meteringRequest.timezone).toBe("Pacific/Auckland");
    expect(meteringRequest.timezone).not.toBe("Africa/Kampala");

    // And the reading actually flowed into a preview row.
    const preview = out.results.find((r) => r.kind === "preview");
    expect(preview).toBeTruthy();
  });

  it("regression guard: closed UTC-stamped period regenerated after microgrid → Africa/Kampala is byte-identical", async () => {
    // Run 1 — before the operator touches the microgrid timezone.
    const before = makeSupabase({
      periodTimezone: "UTC",
      microgridTimezone: "UTC",
      periodStatus: "closed",
    });
    const outBefore = await generatePreview(before.supabase);
    const callBefore = getReadingsCalls[0];

    // Run 2 — the microgrid has since been switched to Africa/Kampala. The
    // period's stamp is immutable (#354's trigger fires only on INSERT), so
    // NOTHING about the adapter call or the computed line items may change.
    const after = makeSupabase({
      periodTimezone: "UTC", // the stamp does not move
      microgridTimezone: "Africa/Kampala",
      periodStatus: "closed",
    });
    const outAfter = await generatePreview(after.supabase);
    const callAfter = getReadingsCalls[1];

    expect(getReadingsCalls).toHaveLength(2);

    // Window params byte-identical — serialised comparison so any added,
    // removed, or re-derived argument fails loudly.
    expect(JSON.stringify(callAfter)).toBe(JSON.stringify(callBefore));
    expect(callAfter.timezone).toBe("UTC");

    // Line items byte-identical.
    expect(JSON.stringify(outAfter.results)).toBe(
      JSON.stringify(outBefore.results)
    );
    // And not vacuously: a real computed row exists on both sides.
    const preview = outBefore.results.find((r) => r.kind === "preview") as
      | { usageKwh: number; totalAmount: number }
      | undefined;
    expect(preview?.usageKwh).toBe(178.35);
    expect(preview?.totalAmount).toBe(17835);
  });
});
