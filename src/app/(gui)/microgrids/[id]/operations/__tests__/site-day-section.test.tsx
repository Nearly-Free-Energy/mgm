// SiteDaySection — the async server component that reads one day's
// operations inside the Operations page's Suspense boundary.
//
// Strategy:
//   - Mock @/lib/supabase/server: the section creates its own client.
//   - Mock @/lib/metering/compose so composeMetering yields a stub
//     capability whose getSiteDay the tests control, plus a dispose spy.
//   - Await SiteDaySection(...) directly and serialise the returned JSX.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { computeSiteDay } from "@/lib/metering/site-operations";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { createClientMock, composeMeteringMock, getSiteDayMock, disposeMock, SUPABASE } =
  vi.hoisted(() => ({
    createClientMock: vi.fn(),
    composeMeteringMock: vi.fn(),
    getSiteDayMock: vi.fn(),
    disposeMock: vi.fn(),
    SUPABASE: { from: () => undefined },
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

import { SiteDayLoading, SiteDaySection, withoutFlows } from "../site-day-section";
import { DailyOperations } from "@/components/operations/daily-operations";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DATE = "2026-11-06";
const NOW_MS = Date.parse("2026-11-07T09:00:00Z");

function siteDay(date: string) {
  return computeSiteDay({
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
      houseEnergyWh: {},
    },
    sources: {
      battery: true,
      gridMeter: true,
      load: false,
      pv: false,
      houses: false,
      houseMetersUnreadable: 0,
    },
    resolutionMinutes: 15,
    nowMs: NOW_MS,
  });
}

async function renderSection(): Promise<string> {
  const jsx = await SiteDaySection({
    organizationId: "org-1",
    microgridId: "mg-1",
    date: DATE,
  });
  return renderToStaticMarkup(jsx);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SiteDaySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createClientMock.mockResolvedValue(SUPABASE);
    disposeMock.mockResolvedValue(undefined);
    getSiteDayMock.mockImplementation(async ({ date }: { date: string }) => ({
      ok: true,
      data: siteDay(date),
    }));
    composeMeteringMock.mockResolvedValue({
      ok: true,
      data: { metering: { getSiteDay: getSiteDayMock }, dispose: disposeMock },
    });
  });

  it("composes metering with its own client for the organization", async () => {
    await renderSection();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(composeMeteringMock).toHaveBeenCalledTimes(1);
    expect(composeMeteringMock).toHaveBeenCalledWith({
      supabase: SUPABASE,
      organizationId: "org-1",
    });
  });

  it("reads the microgrid's day", async () => {
    await renderSection();

    expect(getSiteDayMock).toHaveBeenCalledTimes(1);
    expect(getSiteDayMock).toHaveBeenCalledWith({ microgrid_id: "mg-1", date: DATE });
  });

  it("disposes the composition after a successful read", async () => {
    await renderSection();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("disposes the composition when getSiteDay throws, and lets the error through", async () => {
    getSiteDayMock.mockRejectedValue(new Error("boom"));

    await expect(renderSection()).rejects.toThrow("boom");
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("disposes the composition when getSiteDay returns a failure", async () => {
    getSiteDayMock.mockResolvedValue({
      ok: false,
      status: 503,
      code: "METERING_UNAVAILABLE",
      message: "OpenEMS did not answer.",
    });

    await renderSection();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("hands DailyOperations the day without its per-bin flows", async () => {
    const day = { ...siteDay(DATE), flows: [{ atMs: 1, hour: 0, batteryW: 5, gridW: 1, solarW: 0, gridPresent: true }] };
    getSiteDayMock.mockResolvedValue({ ok: true, data: day });

    const jsx = (await SiteDaySection({
      organizationId: "org-1",
      microgridId: "mg-1",
      date: DATE,
    })) as React.ReactElement<{ day: typeof day }>;

    expect(jsx.type).toBe(DailyOperations);
    expect("flows" in jsx.props.day).toBe(false);
    const { flows: _ignored, ...rest } = day;
    void _ignored;
    expect(jsx.props.day).toEqual(rest);
  });

  it("renders the operations view on success", async () => {
    const html = await renderSection();

    expect(html).toContain("Battery level (%)");
    expect(html).not.toContain("Could not load this day");
    expect(html).not.toContain("Metering is disabled");
  });

  it("renders the 'Metering is disabled' banner when composition returns 409", async () => {
    composeMeteringMock.mockResolvedValue({
      ok: false,
      status: 409,
      code: "plugin_disabled",
      message: "Metering is disabled for this organization.",
    });

    const html = await renderSection();

    expect(html).toContain("Metering is disabled");
    expect(html).toContain("Metering is disabled for this organization.");
    expect(html).toContain("bg-warning-muted");
    expect(html).not.toContain("bg-destructive-muted");
    expect(getSiteDayMock).not.toHaveBeenCalled();
    // Nothing was composed, so there is nothing to dispose.
    expect(disposeMock).not.toHaveBeenCalled();
  });

  it("renders the 'Metering is disabled' banner when getSiteDay returns 409", async () => {
    getSiteDayMock.mockResolvedValue({
      ok: false,
      status: 409,
      code: "plugin_disabled",
      message: "Metering is off.",
    });

    const html = await renderSection();

    expect(html).toContain("Metering is disabled");
    expect(html).toContain("Metering is off.");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("<a ");
  });

  it("names mixed synthetic and real edges, not a disabled plugin, and points at Edges", async () => {
    getSiteDayMock.mockResolvedValue({
      ok: false,
      status: 409,
      code: "METERING_CONFIGURATION",
      message: "This microgrid mixes synthetic and real edges; keep synthetic data in its own microgrid.",
    });

    const html = await renderSection();

    expect(html).toContain("Synthetic and real edges are mixed");
    expect(html).toContain("mixes synthetic and real edges");
    expect(html).toContain("bg-warning-muted");
    expect(html).toContain('href="/microgrids/mg-1/setup/edges"');
    expect(html).not.toContain("Metering is disabled");
    expect(html).not.toContain("setup/openems-backend");
  });

  it("renders the setup EmptyState when the site has no battery or grid meter", async () => {
    getSiteDayMock.mockResolvedValue({
      ok: false,
      status: 404,
      code: "metering_no_site_devices",
      message: "No battery or grid meter is registered.",
    });

    const html = await renderSection();

    expect(html).toContain("Register the battery and grid meter");
    expect(html).toContain("set their types to Battery and Grid meter");
    expect(html).toContain("set the meter on the inverter&#x27;s output to Inverter");
    expect(html).toContain('href="/microgrids/mg-1/setup/edges"');
    expect(html).toContain("Go to Edges");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Could not load this day");
  });

  it("renders the destructive banner with the message for other failures", async () => {
    getSiteDayMock.mockResolvedValue({
      ok: false,
      status: 503,
      code: "METERING_UNAVAILABLE",
      message: "OpenEMS did not answer.",
    });

    const html = await renderSection();

    expect(html).toContain("Could not load this day&#x27;s operations");
    expect(html).toContain("OpenEMS did not answer.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("bg-destructive-muted");
    expect(html).not.toContain("Metering is disabled");
    // The way forward is another try at the same day, as a full page load.
    expect(html).toContain(`href="/microgrids/mg-1/operations?date=${DATE}"`);
    expect(html).toContain("Try again");
    expect(html).not.toContain("setup/openems-backend");
  });

  it("points a configuration failure at the OpenEMS connection setup", async () => {
    getSiteDayMock.mockResolvedValue({
      ok: false,
      status: 503,
      code: "METERING_CONFIGURATION",
      message: "Metering provider is not configured for this microgrid",
    });

    const html = await renderSection();

    expect(html).toContain("Could not load this day&#x27;s operations");
    expect(html).toContain("Metering provider is not configured for this microgrid");
    expect(html).toContain('href="/microgrids/mg-1/setup/openems-backend"');
    expect(html).toContain("Set up the OpenEMS connection");
    expect(html).not.toContain("Try again");
  });

  it("renders the destructive banner when composition fails with something other than 409", async () => {
    composeMeteringMock.mockResolvedValue({
      ok: false,
      status: 401,
      code: "unauthenticated",
      message: "Sign in again.",
    });

    const html = await renderSection();

    expect(html).toContain("Could not load this day&#x27;s operations");
    expect(html).toContain("Sign in again.");
    expect(getSiteDayMock).not.toHaveBeenCalled();
  });
});

describe("withoutFlows", () => {
  it("drops flows, keeps every other field, and leaves the input alone", () => {
    const day = {
      ...siteDay(DATE),
      flows: [{ atMs: 1, hour: 3, batteryW: -200, gridW: 300, solarW: null, gridPresent: true }],
    };
    const stripped = withoutFlows(day);

    expect("flows" in stripped).toBe(false);
    expect(stripped.knownMinutes).toBe(day.knownMinutes);
    expect(stripped.date).toBe(DATE);
    expect(day.flows).toHaveLength(1);
  });
});

describe("SiteDayLoading", () => {
  it("is an accessible, busy status placeholder", () => {
    const root = renderToStaticMarkup(<SiteDayLoading />);

    expect(root).toContain('role="status"');
    expect(root).toContain('aria-busy="true"');
    expect(root).toContain('aria-label="Loading the day&#x27;s operations"');
    expect(root).toContain("Loading the day&#x27;s operations…");
  });

  it("uses token classes only", () => {
    const html = renderToStaticMarkup(<SiteDayLoading />);
    expect(html).not.toMatch(/\b(?:bg|text|border)-(?:red|blue|green|gray|slate|zinc)-\d/);
  });
});
