/**
 * meterCoverage decides, as the bill engine does with effective-dated
 * assignments, whether a tenant's meter is read for a period. The second
 * block runs the engine on the same links, so the two cannot drift apart.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { coversPeriod, meterCoverage, overlapsPeriod, type MeterCoverage, type PrimaryMeterLink } from "../meter-coverage";
import { isRunGenerationFatal, runGenerationFor } from "../generate";
import type { MeteringProvider } from "@/lib/metering/types";

const PERIOD = { start_date: "2026-04-01", end_date: "2026-04-30" };
const meter = { openems_component_id: "meter1", edges: { openems_edge_id: "edge0" } };
const link = (from: string | null, to: string | null, devices: PrimaryMeterLink["devices"] = meter): PrimaryMeterLink => ({
  effective_from: from,
  effective_to: to,
  devices,
});

const CASES: [string, PrimaryMeterLink[], MeterCoverage][] = [
  ["no link", [], "no_meter"],
  ["one link covering the period", [link("2020-01-01", null)], "metered"],
  ["a link ending the day after the period", [link("2026-04-01", "2026-05-01")], "metered"],
  ["a link ending on the period's last day", [link("2020-01-01", "2026-04-30")], "assignment_gap"],
  ["a link starting after the period", [link("2026-05-01", null)], "assignment_gap"],
  ["a link that ended before the period", [link("2020-01-01", "2026-04-01")], "assignment_gap"],
  ["a link with no start date", [link(null, null)], "assignment_gap"],
  ["a replacement within the period", [link("2020-01-01", "2026-04-15"), link("2026-04-15", null)], "assignment_gap"],
  ["two links covering the period", [link("2020-01-01", null), link("2021-01-01", null)], "assignment_gap"],
  ["a covering link with no meter", [link("2020-01-01", null, null)], "no_meter"],
  ["a covering meter with no component", [link("2020-01-01", null, { ...meter, openems_component_id: null })], "no_meter"],
  ["a covering meter on an edge with no OpenEMS id", [link("2020-01-01", null, { ...meter, edges: { openems_edge_id: null } })], "no_meter"],
  ["a covering meter on no edge", [link("2020-01-01", null, { ...meter, edges: null })], "no_meter"],
  ["embedded rows as arrays", [link("2020-01-01", null, [{ ...meter, edges: [{ openems_edge_id: "edge0" }] }])], "metered"],
];

describe("meterCoverage", () => {
  it.each(CASES)("%s", (_label, links, coverage) => {
    expect(meterCoverage(links, PERIOD)).toBe(coverage);
  });

  it("tests half-open assignment dates against an inclusive period end", () => {
    expect(overlapsPeriod({ effective_from: "2026-04-30", effective_to: null }, PERIOD)).toBe(true);
    expect(overlapsPeriod({ effective_from: "2026-03-01", effective_to: "2026-04-02" }, PERIOD)).toBe(true);
    expect(coversPeriod({ effective_from: "2026-04-01", effective_to: "2026-05-01" }, PERIOD)).toBe(true);
    expect(coversPeriod({ effective_from: "2026-04-02", effective_to: null }, PERIOD)).toBe(false);
  });
});

/** The engine's outcome for one tenant with these links: as meterCoverage names it. */
async function engineCoverage(links: PrimaryMeterLink[]): Promise<MeterCoverage> {
  const rows: Record<string, unknown> = {
    billing_periods: { data: { id: "p", microgrid_id: "m", ...PERIOD, timezone: "UTC", status: "draft", rate_schedule_id: "s" }, error: null },
    rate_schedules: { data: { tiers: [{ label: "T1", min_kwh: 1, max_kwh: null, rate_per_kwh: 1 }], service_charge: 0, tax_rate: 0 }, error: null },
    tenants: {
      data: [
        {
          id: "t",
          display_name: "Unit",
          tenant_devices: links.map((l) => ({ role: "primary_consumption_meter", ...l, devices: l.devices && !Array.isArray(l.devices) ? { id: "d", ...l.devices } : l.devices })),
        },
      ],
      error: null,
    },
  };
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "lte", "in", "not", "order"]) b[m] = () => b;
    b.single = async () => rows[table];
    b.maybeSingle = async () => rows[table];
    b.then = (f: (v: unknown) => unknown) => Promise.resolve(table === "tenants" ? rows.tenants : { data: [], error: null }).then(f);
    return b;
  };
  const supabase = {
    from: builder,
    rpc: vi.fn(async (name: string) => (name === "fn_pin_billing_period_rate_schedule" ? { data: "s", error: null } : { data: {}, error: null })),
  } as unknown as SupabaseClient;
  const meteringProvider = { getReadings: async () => [{ deviceId: "d", usageKwh: 1 }] } as unknown as MeteringProvider;
  const out = await runGenerationFor({
    supabase,
    periodId: "p",
    mode: "preview",
    actorUserId: null,
    meteringProvider,
    requireEffectiveDatedAssignments: true,
    allowUsageOnlyReadings: true,
  });
  if (isRunGenerationFatal(out)) throw new Error(out.body.error);
  const [r] = out.results;
  if (r.kind === "preview") return "metered";
  if (r.kind === "error" && r.code === "unmetered_no_manual") return "no_meter";
  if (r.kind === "error" && r.code === "meter_assignment_continuity") return "assignment_gap";
  throw new Error(`unexpected ${JSON.stringify(r)}`);
}

describe("meterCoverage agrees with the bill engine", () => {
  // The engine reads embedded rows as objects; arrays are the loader's shape.
  it.each(CASES.filter(([label]) => label !== "embedded rows as arrays"))("%s", async (_label, links, coverage) => {
    expect(await engineCoverage(links)).toBe(coverage);
  });
});
