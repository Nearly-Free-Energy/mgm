// SavingsSection — the async server component that values the site's days
// against the grid tariff, inside the Operations page's second Suspense
// boundary.
//
// Strategy:
//   - Mock @/lib/supabase/server: the section reads grid_tariffs and
//     microgrid_savings_settings through its own client, whose `from` the
//     tests dispatch per table.
//   - Mock @/lib/metering/compose so composeMetering yields a stub
//     capability whose getSiteDays the tests control, plus a dispose spy.
//   - Use the real valueSiteDays on hand-built days, so the figures on the
//     page are the ones the pure module computes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { computeSiteDay, type SiteDayOperations, type SiteFlow } from "@/lib/metering/site-operations";
import { addDaysToDateKey } from "@/lib/timezone/day-key";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { createClientMock, composeMeteringMock, getSiteDaysMock, disposeMock, fromMock } =
  vi.hoisted(() => ({
    createClientMock: vi.fn(),
    composeMeteringMock: vi.fn(),
    getSiteDaysMock: vi.fn(),
    disposeMock: vi.fn(),
    fromMock: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: createClientMock,
}));

vi.mock("@/lib/metering/compose", () => ({
  composeMetering: composeMeteringMock,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

// ── Import (after mocks) ──────────────────────────────────────────────────────

import { SavingsLoading, SavingsSection, savingsReadRange } from "../savings-section";
import { SavingsTable } from "@/components/operations/savings-table";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DATE = "2026-11-06";
const SUPABASE = { from: fromMock };

const BANDS = [
  { from_hour: 0, to_hour: 6, rate: 400 },
  { from_hour: 6, to_hour: 18, rate: 550 },
  { from_hour: 18, to_hour: 24, rate: 650 },
];
const TARIFFS = [{ effective_from: "2026-01-01", bands: BANDS }];
const SETTINGS = {
  solar_savings_from: "2026-11-01",
  arbitrage_from: null as string | null,
  round_trip_efficiency: 0.9,
};

/**
 * A day with one hour of 1 200 W of solar at noon: 12 bins of 5 minutes,
 * 1.2 kWh, worth 1.2 × 550 = 660 at the midday rate.
 */
function solarDay(date: string): SiteDayOperations {
  const base = computeSiteDay({
    date,
    timezone: "Africa/Kampala",
    samples: {
      timestamps: [],
      batterySocPct: [],
      batteryPowerW: [],
      gridPowerW: [],
      gridVoltageV: [],
      loadPowerW: [],
      pvPowerW: [],
    },
    sources: { battery: true, gridMeter: true, load: false, pv: true },
    resolutionMinutes: 5,
    nowMs: Date.parse("2026-11-07T09:00:00Z"),
  });
  const flows: SiteFlow[] = Array.from({ length: 12 }, (_, i) => ({
    atMs: base.dayStartMs + (12 * 60 + i * 5) * 60_000,
    hour: 12,
    batteryW: null,
    gridW: null,
    solarW: 1200,
    gridPresent: true,
  }));
  return {
    ...base,
    resolutionMinutes: 5,
    solarKwh: 1.2,
    solarEstimated: false,
    knownMinutes: 1440,
    darkMinutes: 0,
    flows,
  };
}

/** Every day from `start` to `end`, inclusive. */
function days(start: string, end: string): SiteDayOperations[] {
  const out: SiteDayOperations[] = [];
  for (let d = start; d <= end; d = addDaysToDateKey(d, 1)) out.push(solarDay(d));
  return out;
}

type Reads = {
  tariffs?: unknown[] | null;
  settings?: unknown | null;
  tariffsError?: { message: string } | null;
  settingsError?: { message: string } | null;
};

/** A chainable query that resolves to `result` when awaited or ended with maybeSingle. */
function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "maybeSingle") return () => Promise.resolve(result);
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return () => chain;
      },
    }
  );
  return chain;
}

function stubReads({
  tariffs = TARIFFS,
  settings = SETTINGS,
  tariffsError = null,
  settingsError = null,
}: Reads = {}) {
  fromMock.mockImplementation((table: string) => {
    if (table === "grid_tariffs") return query({ data: tariffs, error: tariffsError });
    if (table === "microgrid_savings_settings") {
      return query({ data: settings, error: settingsError });
    }
    throw new Error(`unexpected table ${table}`);
  });
}

async function section(date = DATE): Promise<React.ReactElement | null> {
  return (await SavingsSection({
    organizationId: "org-1",
    microgridId: "mg-1",
    date,
  })) as React.ReactElement | null;
}

async function renderSection(date = DATE): Promise<string> {
  const jsx = await section(date);
  return jsx ? renderToStaticMarkup(jsx) : "";
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("savingsReadRange", () => {
  it("starts at the 1st of the month when the start dates are later", () => {
    expect(
      savingsReadRange(DATE, { ...SETTINGS, solar_savings_from: "2026-11-04" })
    ).toEqual({ start: "2026-11-01", capped: false });
  });

  it("starts at the earlier start date when it is before the month", () => {
    expect(
      savingsReadRange(DATE, {
        solar_savings_from: "2026-09-15",
        arbitrage_from: "2026-08-20",
        round_trip_efficiency: 0.9,
      })
    ).toEqual({ start: "2026-08-20", capped: false });
  });

  it("ignores a missing start date", () => {
    expect(
      savingsReadRange(DATE, {
        solar_savings_from: null,
        arbitrage_from: "2026-10-01",
        round_trip_efficiency: 0.9,
      })
    ).toEqual({ start: "2026-10-01", capped: false });
  });

  it("reads exactly 366 days without capping", () => {
    const start = addDaysToDateKey(DATE, -365);
    expect(savingsReadRange(DATE, { ...SETTINGS, solar_savings_from: start })).toEqual({
      start,
      capped: false,
    });
  });

  it("caps a longer range to the last 366 days", () => {
    expect(
      savingsReadRange(DATE, { ...SETTINGS, solar_savings_from: "2024-01-01" })
    ).toEqual({ start: "2025-11-06", capped: true });
  });
});

describe("SavingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createClientMock.mockResolvedValue(SUPABASE);
    disposeMock.mockResolvedValue(undefined);
    stubReads();
    getSiteDaysMock.mockImplementation(
      async ({ start_date, end_date }: { start_date: string; end_date: string }) => ({
        ok: true,
        data: days(start_date, end_date),
      })
    );
    composeMeteringMock.mockResolvedValue({
      ok: true,
      data: { metering: { getSiteDays: getSiteDaysMock }, dispose: disposeMock },
    });
  });

  it("reads the tariff and the settings for the microgrid through its own client", async () => {
    await section();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(fromMock).toHaveBeenCalledWith("grid_tariffs");
    expect(fromMock).toHaveBeenCalledWith("microgrid_savings_settings");
  });

  it("composes metering with the same client for the organization", async () => {
    await section();

    expect(composeMeteringMock).toHaveBeenCalledTimes(1);
    expect(composeMeteringMock).toHaveBeenCalledWith({
      supabase: SUPABASE,
      organizationId: "org-1",
    });
  });

  it("reads the days from the 1st of the month to the day", async () => {
    await section();

    expect(getSiteDaysMock).toHaveBeenCalledTimes(1);
    expect(getSiteDaysMock).toHaveBeenCalledWith({
      microgrid_id: "mg-1",
      start_date: "2026-11-01",
      end_date: DATE,
    });
  });

  it("reads from an earlier start date", async () => {
    stubReads({ settings: { ...SETTINGS, arbitrage_from: "2026-09-10" } });
    await section();

    expect(getSiteDaysMock).toHaveBeenCalledWith({
      microgrid_id: "mg-1",
      start_date: "2026-09-10",
      end_date: DATE,
    });
  });

  it("caps the read at 366 days and says so", async () => {
    stubReads({ settings: { ...SETTINGS, solar_savings_from: "2024-03-01" } });
    const jsx = await section();

    expect(getSiteDaysMock).toHaveBeenCalledWith({
      microgrid_id: "mg-1",
      start_date: "2025-11-06",
      end_date: DATE,
    });
    expect((jsx as React.ReactElement<{ cappedFrom: string | null }>).props.cappedFrom).toBe(
      "2025-11-06"
    );
    const html = renderToStaticMarkup(jsx!);
    expect(html).toContain("Since start covers at most a year");
  });

  it("renders the figures valued with the real calculation", async () => {
    const html = await renderSection();

    expect(html).toContain("What the site saved");
    // Day: 660. Month so far and since start: six days of 660.
    expect(html).toMatch(/UGX\s660/);
    expect(html).toMatch(/UGX\s3,960/);
    expect(html).not.toContain("Could not work out the savings");
  });

  it("hands the client table only the summary and the dates, not the days", async () => {
    const jsx = (await section()) as React.ReactElement<Record<string, unknown>>;

    expect(jsx.type).toBe(SavingsTable);
    expect(Object.keys(jsx.props).sort()).toEqual(
      ["arbitrageFrom", "cappedFrom", "date", "solarEstimated", "solarFrom", "summary"].sort()
    );
    expect(jsx.props).toMatchObject({
      date: DATE,
      solarFrom: "2026-11-01",
      arbitrageFrom: null,
      cappedFrom: null,
      solarEstimated: false,
    });
    expect(JSON.stringify(jsx.props)).not.toContain("flows");
  });

  it("disposes the composition after a successful read", async () => {
    await section();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("disposes the composition when getSiteDays throws, and lets the error through", async () => {
    getSiteDaysMock.mockRejectedValue(new Error("boom"));

    await expect(section()).rejects.toThrow("boom");
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("disposes the composition when getSiteDays returns a failure", async () => {
    getSiteDaysMock.mockResolvedValue({
      ok: false,
      status: 503,
      code: "METERING_UNAVAILABLE",
      message: "OpenEMS did not answer.",
    });

    await section();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["there are no settings", { settings: null }],
    ["neither saving has a start date", { settings: { ...SETTINGS, solar_savings_from: null } }],
    ["there is no grid tariff", { tariffs: [] }],
  ])("shows the setup note and reads nothing when %s", async (_label, reads) => {
    stubReads(reads as Reads);
    const html = await renderSection();

    expect(html).toContain("Count what the site saves");
    expect(html).toContain('href="/microgrids/mg-1/setup/rates"');
    expect(html).toContain("Go to Setup &gt; Rates");
    expect(composeMeteringMock).not.toHaveBeenCalled();
    expect(getSiteDaysMock).not.toHaveBeenCalled();
  });

  it("shows a destructive banner and reads nothing when the tariff read fails", async () => {
    stubReads({ tariffsError: { message: "permission denied" } });
    const html = await renderSection();

    expect(html).toContain("Could not load the savings settings");
    expect(html).toContain("permission denied");
    expect(html).toContain('role="alert"');
    expect(composeMeteringMock).not.toHaveBeenCalled();
  });

  it("shows a destructive banner when the settings read fails", async () => {
    stubReads({ settingsError: { message: "relation does not exist" } });
    const html = await renderSection();

    expect(html).toContain("relation does not exist");
    expect(composeMeteringMock).not.toHaveBeenCalled();
  });

  it("renders nothing when the site has no battery or grid meter (the day section explains)", async () => {
    getSiteDaysMock.mockResolvedValue({
      ok: false,
      status: 404,
      code: "metering_no_site_devices",
      message: "No battery or grid meter is registered.",
    });

    expect(await section()).toBeNull();
  });

  it("renders nothing while Metering is disabled (the day section explains)", async () => {
    composeMeteringMock.mockResolvedValue({
      ok: false,
      status: 409,
      code: "plugin_disabled",
      message: "Metering is disabled for this organization.",
    });

    expect(await section()).toBeNull();
    expect(getSiteDaysMock).not.toHaveBeenCalled();
    expect(disposeMock).not.toHaveBeenCalled();
  });

  it("renders a destructive banner with the message for other failures", async () => {
    getSiteDaysMock.mockResolvedValue({
      ok: false,
      status: 503,
      code: "METERING_UNAVAILABLE",
      message: "OpenEMS did not answer.",
    });

    const html = await renderSection();

    expect(html).toContain("Could not work out the savings");
    expect(html).toContain("OpenEMS did not answer.");
    expect(html).toContain('role="alert"');
  });

  it("renders a destructive banner when composition fails with 401", async () => {
    composeMeteringMock.mockResolvedValue({
      ok: false,
      status: 401,
      code: "unauthenticated",
      message: "Sign in again.",
    });

    const html = await renderSection();

    expect(html).toContain("Could not work out the savings");
    expect(html).toContain("Sign in again.");
    expect(getSiteDaysMock).not.toHaveBeenCalled();
  });
});

describe("SavingsLoading", () => {
  it("is an accessible, busy status placeholder with token classes only", () => {
    const html = renderToStaticMarkup(<SavingsLoading />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading the savings"');
    expect(html).not.toMatch(/\b(?:bg|text|border)-(?:red|blue|green|gray|slate|zinc)-\d/);
  });
});
