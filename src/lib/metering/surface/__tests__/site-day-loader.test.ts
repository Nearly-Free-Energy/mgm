/**
 * The `metering.site-day` loader: the organization and client come from the
 * request, the day from `?date=`, every composition is disposed, refusals
 * carry fixed copy, and only the capability's read is used.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import type { Fmt, SurfaceRequest } from "@/lib/gui/surface";
import { generateSiteSamples } from "../../fixture/site-samples";
import { computeSiteDay } from "../../site-operations";

const composeMetering = vi.fn();
vi.mock("@/lib/metering/compose", () => ({ composeMetering: (...args: unknown[]) => composeMetering(...args) }));

import { loadSiteDay, SITE_DAY_REFUSALS, siteDayRefusal } from "../site-day";

const ORG = "e7500000-0000-4000-8000-000000000001";
const MG = "e7500000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-11-09T08:00:00Z"); // 11:00 in Kampala
const UPSTREAM = "upstream said: token abc123 refused";

let microgrid: { data: unknown; error: unknown };
let reads: unknown[];
let calls: string[];
let dispose: ReturnType<typeof vi.fn>;
let getSiteDay: ReturnType<typeof vi.fn>;

/** A client whose microgrids read answers `microgrid`; `reads` records the filters. */
function client(): SupabaseClient {
  const chain = {
    select: (columns: string) => (reads.push(["select", columns]), chain),
    eq: (column: string, value: string) => (reads.push(["eq", column, value]), chain),
    maybeSingle: async () => microgrid,
  };
  return { from: (table: string) => (reads.push(["from", table]), chain) } as unknown as SupabaseClient;
}

/** The capability as the loader sees it: any member other than getSiteDay is recorded. */
function facade() {
  return new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      calls.push(prop);
      return prop === "getSiteDay" ? getSiteDay : vi.fn();
    },
  });
}

const request = (search = "", locale = "en-GB", fmt: Fmt = createFmt({ locale })): SurfaceRequest => ({
  supabase: client(),
  user: { id: "u1" } as User,
  roles: [],
  organizationId: ORG,
  params: { id: MG },
  search: new URLSearchParams(search),
  locale,
  now: NOW,
  fmt,
});

/** The request's Fmt for `locale`, recording which of its methods were called. */
function spyFmt(locale: string): { fmt: Fmt; used: Set<string> } {
  const real = createFmt({ locale }) as unknown as Record<string, unknown>;
  const used = new Set<string>();
  const fmt = new Proxy(real, {
    get(target, prop) {
      const value = target[prop as string];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => (used.add(String(prop)), (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  }) as unknown as Fmt;
  return { fmt, used };
}

function generatedDay(date: string) {
  const device = (id: string) => ({ id, edgeOpenemsId: "SYNTHETIC-EDGE-T", componentId: id });
  const sources = { battery: device("b"), gridMeter: device("g"), load: null, pv: null, houseMeters: [], houseMetersUnreadable: 0 };
  return computeSiteDay({
    date,
    timezone: "Africa/Kampala",
    samples: generateSiteSamples({ microgridId: MG, sources, startDate: "2026-11-07", endDate: date, timezone: "Africa/Kampala", resolutionMinutes: 5 }),
    sources: { battery: true, gridMeter: true, load: false, pv: false, houses: false, houseMetersUnreadable: 0 },
    resolutionMinutes: 5,
    nowMs: NOW.getTime(),
  });
}

beforeEach(() => {
  microgrid = { data: { id: MG, name: "North site", timezone: "Africa/Kampala" }, error: null };
  reads = [];
  calls = [];
  dispose = vi.fn(async () => {});
  getSiteDay = vi.fn(async (q: { date: string }) => ({ ok: true, data: { ...generatedDay(q.date), synthetic: true } }));
  composeMetering.mockReset().mockImplementation(async () => ({ ok: true, data: { metering: facade(), dispose } }));
});

describe("loadSiteDay", () => {
  it("reads the microgrid and composes metering with the request's client and organization", async () => {
    const req = request();
    const out = await loadSiteDay(req);
    expect(out.ok).toBe(true);
    expect(reads).toEqual([["from", "microgrids"], ["select", "id, name, timezone"], ["eq", "id", MG]]);
    expect(composeMetering).toHaveBeenCalledWith({ supabase: req.supabase, organizationId: ORG });
    expect(calls).toEqual(["getSiteDay"]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["no date", "", "2026-11-08"],
    ["a past day", "date=2026-11-01", "2026-11-01"],
    ["today", "date=2026-11-09", "2026-11-09"],
    ["a repeated date", "date=2026-11-01&date=2026-11-02", "2026-11-08"],
    ["a future day", "date=2026-11-10", "2026-11-08"],
    ["a malformed date", "date=2026-02-30", "2026-11-08"],
  ])("reads %s as %s", async (_name, search, date) => {
    await loadSiteDay(request(search));
    expect(getSiteDay).toHaveBeenCalledWith({ microgrid_id: MG, date });
  });

  it("builds the day's model, marked synthetic when the day is", async () => {
    const out = await loadSiteDay(request("date=2026-11-01"));
    if (!out.ok) throw new Error("refused");
    expect(out.model.title).toBe("Operations");
    expect(out.model.entity).toEqual({ kind: "microgrid", id: MG, label: "North site" });
    expect(out.model.body.tiles.every((t) => t.value.synthetic === true)).toBe(true);
    expect(out.model.links?.map((l) => l.id)).toEqual(["metering.day-previous", "metering.day-next", "metering.day-today", "metering.microgrid-setup"]);
    // The page that holds the microgrid's Edit and time zone nudge (decision 15 on #115).
    expect(out.model.links?.at(-1)).toEqual({ id: "metering.microgrid-setup", label: "Microgrid setup", href: `/microgrids/${MG}/setup/edges` });
    const today = await loadSiteDay(request("date=2026-11-09"));
    expect(today.ok && today.model.links?.map((l) => l.id)).toEqual(["metering.day-previous", "metering.microgrid-setup"]);
  });

  it("formats with the request's locale and Fmt", async () => {
    const { fmt, used } = spyFmt("de-DE");
    const out = await loadSiteDay(request("date=2026-11-01", "de-DE", fmt));
    if (!out.ok) throw new Error("refused");
    expect(out.model.subtitle).toBe("So., 01. Nov. 2026 · Africa/Kampala");
    expect(used.size).toBeGreaterThan(0);

    getSiteDay.mockResolvedValue({ ok: false, status: 404, code: "metering_no_site_devices", message: UPSTREAM });
    const setup = spyFmt("de-DE");
    const none = await loadSiteDay(request("date=2026-11-01", "de-DE", setup.fmt));
    if (!none.ok) throw new Error("refused");
    expect(none.model.subtitle).toBe("So., 01. Nov. 2026 · Africa/Kampala");
    expect(setup.used.has("text")).toBe(true);
  });

  it("shows the setup state, with the Edges link, when no battery or grid meter is registered", async () => {
    microgrid = { data: { id: MG, name: "North site", timezone: "Mars/Olympus" }, error: null };
    getSiteDay.mockResolvedValue({ ok: false, status: 404, code: "metering_no_site_devices", message: UPSTREAM });
    const out = await loadSiteDay(request());
    if (!out.ok) throw new Error("refused");
    expect(out.model.links?.[0]).toEqual({ id: "metering.edges", label: "Go to Edges", href: `/microgrids/${MG}/setup/edges` });
    // The resolved day, in UTC, since an unsupported zone reads in UTC.
    expect(out.model.subtitle).toBe("Sun, 08 Nov 2026 · UTC");
    expect(out.model.ext?.data).toMatchObject({ date: "2026-11-08", today: "2026-11-09" });
    expect(getSiteDay).toHaveBeenCalledWith({ microgrid_id: MG, date: "2026-11-08" });
    expect(JSON.stringify(out)).not.toContain(UPSTREAM);
  });

  it("refuses a microgrid it cannot read, without composing", async () => {
    microgrid = { data: null, error: null };
    expect(await loadSiteDay(request())).toEqual(SITE_DAY_REFUSALS.notFound);
    microgrid = { data: null, error: { message: UPSTREAM } };
    expect(await loadSiteDay(request())).toEqual(SITE_DAY_REFUSALS.unavailable);
    expect(composeMetering).not.toHaveBeenCalled();
  });

  it("refuses with fixed copy when composing fails, and has nothing to dispose", async () => {
    composeMetering.mockResolvedValue({ ok: false, status: 500, code: "metering_composition_failed", message: `Could not compose metering: ${UPSTREAM}` });
    expect(await loadSiteDay(request())).toEqual(SITE_DAY_REFUSALS.failed);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("disposes the composition when the day is refused and when the read throws", async () => {
    getSiteDay.mockResolvedValue({ ok: false, status: 503, code: "METERING_UNAVAILABLE", message: UPSTREAM });
    const refused = await loadSiteDay(request());
    expect(refused).toEqual(SITE_DAY_REFUSALS.unavailable);
    expect(JSON.stringify(refused)).not.toContain(UPSTREAM);
    getSiteDay.mockRejectedValue(new Error(UPSTREAM));
    await expect(loadSiteDay(request())).rejects.toThrow(UPSTREAM);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("finishes disposing before it returns", async () => {
    const events: string[] = [];
    let release!: () => void;
    dispose.mockImplementation(() => new Promise<void>((resolve) => (release = () => (events.push("disposed"), resolve()))));
    const loading = loadSiteDay(request()).then(() => events.push("returned"));
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
    release();
    await loading;
    expect(events).toEqual(["disposed", "returned"]);
  });
});

describe("siteDayRefusal", () => {
  it.each([
    [409, "metering_disabled", "disabled"],
    [409, "METERING_CONFIGURATION", "mixed"],
    [503, "METERING_CONFIGURATION", "noConnection"],
    [401, "METERING_UNAUTHORIZED", "rejected"],
    [403, "METERING_UNAUTHORIZED", "rejected"],
    [404, "METERING_INVALID_DATA", "unavailable"],
    [401, "metering_unauthenticated", "forbidden"],
    [403, "metering_forbidden", "forbidden"],
    [400, "metering_invalid_org", "notFound"],
    [404, "metering_not_found", "notFound"],
    [422, "metering_invalid_date", "notFound"],
    [500, "metering_composition_failed", "failed"],
    [503, "metering_gate_unavailable", "unavailable"],
    [502, "METERING_UPSTREAM", "unavailable"],
  ] as const)("maps %i %s to %s", (status, code, refusal) => {
    expect(siteDayRefusal({ status, code })).toBe(SITE_DAY_REFUSALS[refusal]);
  });
});
