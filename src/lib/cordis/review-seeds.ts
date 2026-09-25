import type { SupabaseClient } from "@supabase/supabase-js";
import type { SeedReadingInput } from "@/lib/billing/generate";
import { dayKeyInZone } from "@/lib/timezone/day-key";

type PeriodRow = {
  microgrid_id: string;
  start_date: string;
  timezone: string;
};

type HouseholdRow = {
  id: string;
  household_devices: Array<{
    role: string;
    devices: { id: string } | null;
  }>;
};

type MeterReadingRow = {
  device_id: string;
  reading_kwh: number;
  read_at: string;
};

/**
 * Resolve starting registers for MGM review only.
 *
 * A seed is accepted solely when the imported `meter_readings` table contains
 * exactly one non-negative register at the billing period's local midnight.
 * The browser supplies neither a register nor a timestamp. This preserves the
 * invoice engine's no-invented-start invariant while making a first imported
 * period reviewable when its boundary reading is already in the pilot data.
 *
 * Multiple primary devices (for example a replacement) deliberately receive
 * no seed. The shared engine then returns `needs_seed_reading`, which is safer
 * than choosing a physical register or bridging a reset without evidence.
 */
export async function resolveReviewOnlySeedReadings(
  supabase: SupabaseClient,
  periodId: string,
  householdIds?: string[]
): Promise<SeedReadingInput[]> {
  const { data: period, error: periodError } = await supabase
    .from("billing_periods")
    .select("microgrid_id, start_date, timezone")
    .eq("id", periodId)
    .maybeSingle<PeriodRow>();
  if (periodError || !period) return [];

  const { data: rawHouseholds, error: householdsError } = await supabase
    .from("households")
    .select("id, household_devices(role, devices(id))")
    .eq("microgrid_id", period.microgrid_id)
    .eq("household_devices.role", "primary_consumption_meter");
  if (householdsError) {
    throw new Error("Unable to read meter assignments for review");
  }

  const requested = householdIds ? new Set(householdIds) : null;
  const devices = new Set<string>();
  for (const household of (rawHouseholds ?? []) as unknown as HouseholdRow[]) {
    if (requested && !requested.has(household.id)) continue;
    const primaryDeviceIds = household.household_devices
      .filter((link) => link.role === "primary_consumption_meter" && link.devices)
      .map((link) => link.devices!.id);
    if (primaryDeviceIds.length === 1) devices.add(primaryDeviceIds[0]);
  }
  if (devices.size === 0) return [];

  const boundary = localMidnightInstant(period.start_date, period.timezone);
  if (!boundary) return [];

  // Query only the boundary second. An exact count prevents PostgREST row
  // limits from silently hiding a conflicting register at that instant.
  const { data: rawReadings, error: readingsError, count } = await supabase
    .from("meter_readings")
    .select("device_id, reading_kwh, read_at", { count: "exact" })
    .in("device_id", [...devices])
    .gte("read_at", boundary.toISOString())
    .lt("read_at", new Date(boundary.getTime() + 1000).toISOString());
  if (readingsError || count === null || count !== (rawReadings?.length ?? 0)) {
    throw new Error("Unable to read imported starting registers for review");
  }

  const candidates = new Map<string, MeterReadingRow[]>();
  for (const reading of (rawReadings ?? []) as MeterReadingRow[]) {
    if (
      !devices.has(reading.device_id) ||
      !Number.isFinite(Number(reading.reading_kwh)) ||
      Number(reading.reading_kwh) < 0 ||
      !isPeriodStartBoundary(reading.read_at, period.start_date, period.timezone)
    ) {
      continue;
    }
    const deviceReadings = candidates.get(reading.device_id) ?? [];
    deviceReadings.push(reading);
    candidates.set(reading.device_id, deviceReadings);
  }

  const seeds: SeedReadingInput[] = [];
  for (const [deviceId, readings] of candidates) {
    // Do not choose one when import data is contradictory or duplicated.
    if (readings.length !== 1) continue;
    const reading = readings[0];
    const startKwh = Number(reading.reading_kwh);
    seeds.push({
      deviceId,
      dialReadingKwh: startKwh,
      readAt: reading.read_at,
      startKwh,
    });
  }
  return seeds;
}

function localMidnightInstant(startDate: string, timezone: string): Date | null {
  const utcMidnight = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(utcMidnight)) return null;
  // Every current IANA offset is within a day of UTC. Find the first UTC
  // millisecond belonging to the requested local date, including DST changes.
  let low = utcMidnight - 86_400_000;
  let high = utcMidnight + 86_400_000;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (dayKeyInZone(mid, timezone) < startDate) low = mid + 1;
    else high = mid;
  }
  const boundary = new Date(low);
  return isPeriodStartBoundary(boundary.toISOString(), startDate, timezone)
    ? boundary
    : null;
}

function isPeriodStartBoundary(
  readAt: string,
  startDate: string,
  timezone: string
): boolean {
  const instant = new Date(readAt);
  if (!Number.isFinite(instant.getTime()) || dayKeyInZone(instant, timezone) !== startDate) {
    return false;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return values.hour === "00" && values.minute === "00" && values.second === "00";
}
