import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveReviewOnlySeedReadings } from "../review-seeds";

const PERIOD_ID = "550e8400-e29b-41d4-a716-446655440100";
const DEVICE_ID = "550e8400-e29b-41d4-a716-446655440200";

function fakeSupabase(options: {
  householdDevices?: Array<{ role: string; devices: { id: string } | null }>;
  readings?: Array<{ device_id: string; reading_kwh: number; read_at: string }>;
}) {
  const period = {
    microgrid_id: "550e8400-e29b-41d4-a716-446655440000",
    start_date: "2026-09-01",
    timezone: "Africa/Kampala",
  };
  const households = [{
    id: "550e8400-e29b-41d4-a716-446655440300",
    household_devices: options.householdDevices ?? [
      { role: "primary_consumption_meter", devices: { id: DEVICE_ID } },
    ],
  }];
  const readings = options.readings ?? [];

  function query(table: string) {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "gte", "lt"]) {
      builder[method] = () => builder;
    }
    builder.maybeSingle = async () =>
      table === "billing_periods" ? { data: period, error: null } : { data: null, error: null };
    builder.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({
        data: table === "households" ? households : readings,
        error: null,
        count: table === "meter_readings" ? readings.length : null,
      }).then(resolve);
    return builder;
  }

  return { from: (table: string) => query(table) } as unknown as SupabaseClient;
}

describe("resolveReviewOnlySeedReadings", () => {
  it("uses exactly one imported register at the period's local midnight", async () => {
    const seeds = await resolveReviewOnlySeedReadings(fakeSupabase({
      readings: [
        // Midnight in Africa/Kampala is 21:00 UTC the preceding day.
        { device_id: DEVICE_ID, reading_kwh: 123.45, read_at: "2026-08-31T21:00:00Z" },
      ],
    }), PERIOD_ID);

    expect(seeds).toEqual([{
      deviceId: DEVICE_ID,
      dialReadingKwh: 123.45,
      readAt: "2026-08-31T21:00:00Z",
      startKwh: 123.45,
    }]);
  });

  it("does not create a seed from an arbitrary same-day reading or a replacement", async () => {
    const fromLaterReading = await resolveReviewOnlySeedReadings(fakeSupabase({
      readings: [
        { device_id: DEVICE_ID, reading_kwh: 123.45, read_at: "2026-09-01T06:00:00Z" },
      ],
    }), PERIOD_ID);
    expect(fromLaterReading).toEqual([]);

    const fromReplacement = await resolveReviewOnlySeedReadings(fakeSupabase({
      householdDevices: [
        { role: "primary_consumption_meter", devices: { id: DEVICE_ID } },
        { role: "primary_consumption_meter", devices: { id: "550e8400-e29b-41d4-a716-446655440201" } },
      ],
      readings: [
        { device_id: DEVICE_ID, reading_kwh: 123.45, read_at: "2026-08-31T21:00:00Z" },
      ],
    }), PERIOD_ID);
    expect(fromReplacement).toEqual([]);
  });
});
