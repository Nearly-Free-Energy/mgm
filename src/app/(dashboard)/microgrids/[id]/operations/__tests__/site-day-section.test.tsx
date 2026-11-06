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

import { SiteDayLoading, SiteDaySection } from "../site-day-section";

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
