/**
 * The `metering.site-day` loader: the organization and client come from the
 * request, the day from `?date=`, every composition is disposed, refusals
 * and problems carry fixed copy, each problem carries its reason, every code
 * getSiteDay can answer reaches a declared state, the time zone notice shows
 * in every state, and only the capability's read is used.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import type { Fmt, SurfaceRequest } from "@/lib/gui/surface";
import { METERING_ERROR_CODES } from "../../errors";
import { generateSiteSamples } from "../../fixture/site-samples";
import { computeSiteDay } from "../../site-operations";

const composeMetering = vi.fn();
vi.mock("@/lib/metering/compose", () => ({ composeMetering: (...args: unknown[]) => composeMetering(...args) }));

import { loadSiteDay, SITE_DAY_REFUSALS, siteDayRefusal } from "../site-day";
import { SITE_DAY_PROBLEM_REASONS, SITE_DAY_PROBLEMS, siteDayProblem, type SiteDayProblemReason } from "../site-day-model";

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
    expect(reads).toEqual([["from", "microgrids"], ["select", "id, name, timezone, address_country, lat, lng"], ["eq", "id", MG]]);
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
    getSiteDay.mockResolvedValue({ ok: false, status: 404, code: "metering_not_found", message: UPSTREAM });
    const refused = await loadSiteDay(request());
    expect(refused).toEqual(SITE_DAY_REFUSALS.notFound);
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

describe("loadSiteDay when the metering source cannot read the day", () => {
  const fails = (status: number, code: string) => getSiteDay.mockResolvedValue({ ok: false, status, code, message: UPSTREAM });

  it.each([
    ["mixed edges", 409, "METERING_CONFIGURATION", SITE_DAY_PROBLEMS.mixed, { id: "metering.edges", label: "Go to Edges", href: `/microgrids/${MG}/setup/edges` }],
    ["no connection", 503, "METERING_CONFIGURATION", SITE_DAY_PROBLEMS.noConnection, { id: "metering.openems-backend", label: "Set up the OpenEMS connection", href: `/microgrids/${MG}/setup/openems-backend` }],
    ["rejected settings", 401, "METERING_UNAUTHORIZED", SITE_DAY_PROBLEMS.rejected, { id: "metering.openems-backend", label: "Check the OpenEMS connection", href: `/microgrids/${MG}/setup/openems-backend` }],
  ] as const)("shows %s with the day navigation and the link to the fix first", async (_, status, code, problem, fix) => {
    fails(status, code);
    const out = await loadSiteDay(request("date=2026-11-01"));
    if (!out.ok) throw new Error("refused");
    expect(out.model.links?.[0]).toEqual(fix);
    expect(out.model.links?.map((l) => l.id)).toEqual([fix.id, "metering.day-previous", "metering.day-next", "metering.day-today"]);
    expect(out.model.subtitle).toBe("Sun, 01 Nov 2026 · Africa/Kampala");
    expect(out.model.body.tiles).toEqual([{ key: "problem", label: problem.title, value: { t: "text", text: problem.message } }]);
    expect(out.model.ext?.data).toMatchObject({ state: "problem", date: "2026-11-01", today: "2026-11-09", tone: problem.tone, title: problem.title, message: problem.message, retry: false, timezoneNotice: null });
    expect(JSON.stringify(out)).not.toContain(UPSTREAM);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("offers another try, and the microgrid setup link, when there is nothing to set up", async () => {
    fails(503, "METERING_UNAVAILABLE");
    const out = await loadSiteDay(request("date=2026-11-09"));
    if (!out.ok) throw new Error("refused");
    expect(out.model.ext?.data).toMatchObject({ state: "problem", message: SITE_DAY_PROBLEMS.unavailable.message, retry: true });
    expect(out.model.links?.map((l) => l.id)).toEqual(["metering.day-previous", "metering.microgrid-setup"]);
    expect(JSON.stringify(out)).not.toContain(UPSTREAM);
  });

  it.each([
    [503, "metering_site_devices_unavailable", "siteDevicesUnavailable", true],
    [503, "metering_timezone_unavailable", "zoneUnavailable", true],
    [422, "metering_invalid_date", "dateOutOfRange", true],
    [500, "metering_site_day_failed", "dayFailed", false],
    [503, "metering_site_samples_unsupported", "unsupported", false],
  ] as const)("keeps the day navigation when getSiteDay fails after the gate (%i %s)", async (status, code, problem, retry) => {
    fails(status, code);
    const out = await loadSiteDay(request("date=2026-11-01"));
    if (!out.ok) throw new Error("refused");
    expect(out.model.ext?.data).toMatchObject({ state: "problem", message: SITE_DAY_PROBLEMS[problem].message, retry });
    expect(out.model.links?.map((l) => l.id)).toEqual(["metering.day-previous", "metering.day-next", "metering.day-today", "metering.microgrid-setup"]);
    expect(JSON.stringify(out)).not.toContain(UPSTREAM);
  });

  it("still refuses a failure that is not the source's", async () => {
    fails(403, "metering_forbidden");
    expect(await loadSiteDay(request())).toEqual(SITE_DAY_REFUSALS.forbidden);
    fails(409, "metering_disabled");
    expect(await loadSiteDay(request())).toEqual(SITE_DAY_REFUSALS.disabled);
  });
});

describe("loadSiteDay's problem reasons", () => {
  const fails = (status: number, code: string) => getSiteDay.mockResolvedValue({ ok: false, status, code, message: UPSTREAM });
  const reasonOf = (out: Awaited<ReturnType<typeof loadSiteDay>>) => (out.ok ? (out.model.ext?.data as { reason?: string }).reason : undefined);

  // One failure per reason, as getSiteDay answers it.
  it.each([
    ["mixed_edges", 409, "METERING_CONFIGURATION"],
    ["not_configured", 503, "METERING_CONFIGURATION"],
    ["credentials_rejected", 401, "METERING_UNAUTHORIZED"],
    ["unsupported", 503, "metering_site_samples_unsupported"],
    ["upstream_unavailable", 503, "METERING_UNAVAILABLE"],
    ["invalid_data", 503, "METERING_INVALID_DATA"],
    ["unreadable_timestamps", 503, "METERING_UNREADABLE_TIMESTAMPS"],
    ["site_devices_unavailable", 503, "metering_site_devices_unavailable"],
    ["zone_unavailable", 503, "metering_timezone_unavailable"],
    ["date_out_of_range", 422, "metering_invalid_date"],
    ["day_failed", 500, "metering_site_day_failed"],
  ] as const satisfies readonly (readonly [SiteDayProblemReason, number, string])[])(
    "shows %s, with its own copy and never the source's",
    async (reason, status, code) => {
      fails(status, code);
      const out = await loadSiteDay(request("date=2026-11-01"));
      if (!out.ok) throw new Error("refused");
      const problem = Object.values(SITE_DAY_PROBLEMS).find((p) => p.reason === reason)!;
      expect(out.model.ext?.data).toMatchObject({ state: "problem", reason, title: problem.title, message: problem.message, retry: problem.retry });
      expect(out.model.links?.map((l) => l.id)).toEqual(expect.arrayContaining(["metering.day-previous"]));
      expect(JSON.stringify(out)).not.toContain(UPSTREAM);
    },
  );

  it("tells a source that cannot read site samples from one that is not set up, and from one that did not answer", async () => {
    fails(503, "metering_site_samples_unsupported");
    const unsupported = await loadSiteDay(request("date=2026-11-01"));
    fails(503, "METERING_CONFIGURATION");
    const notConfigured = await loadSiteDay(request("date=2026-11-01"));
    fails(503, "METERING_UNAVAILABLE");
    const unavailable = await loadSiteDay(request("date=2026-11-01"));
    expect([unsupported, notConfigured, unavailable].map(reasonOf)).toEqual(["unsupported", "not_configured", "upstream_unavailable"]);
    if (!unsupported.ok || !notConfigured.ok || !unavailable.ok) throw new Error("refused");
    // Nothing to set up and nothing to retry; the others link their fix or retry.
    expect(unsupported.model.ext?.data).toMatchObject({ retry: false });
    expect(unsupported.model.links?.map((l) => l.id)).not.toContain("metering.openems-backend");
    expect(notConfigured.model.links?.[0].id).toBe("metering.openems-backend");
    expect(unavailable.model.ext?.data).toMatchObject({ retry: true });
  });
});

/**
 * The codes getSiteDay can answer, read from src/lib/metering/capability.ts:
 * every metering_ or METERING_ string in getSiteDay and the methods and
 * module-level `function` declarations it calls by name, followed through
 * `this.<method>(` and `<function>(`, and every MeteringError code, which
 * fromMeteringError passes on from the provider and its selection. A code
 * built at run time, one passed in from a module this does not read, or one
 * in a module-level arrow function would be missed; if capability.ts starts
 * doing any of these, revisit.
 */
function siteDayCodes(): Set<string> {
  const source = readFileSync(join(process.cwd(), "src", "lib", "metering", "capability.ts"), "utf8");
  // The constructor's fields the methods call; they hold no codes of their own.
  const fields = new Set(["isActive", "selectProvider"]);
  const functions = new Set([...source.matchAll(/\n(?:export )?(?:async )?function (\w+)\(/g)].map((m) => m[1]));
  const seen = new Set<string>();
  const codes = new Set<string>(METERING_ERROR_CODES);
  const visit = (name: string, kind: "method" | "function") => {
    if (seen.has(`${kind}:${name}`)) return;
    seen.add(`${kind}:${name}`);
    const body = bodyOf(source, name, kind);
    for (const m of body.matchAll(/"(metering_[a-z_]+|METERING_[A-Z_]+)"/g)) codes.add(m[1]);
    for (const m of body.matchAll(/\bthis\.(\w+)\(/g)) if (!fields.has(m[1])) visit(m[1], "method");
    for (const m of body.matchAll(/(?<![.\w])(\w+)\(/g)) if (functions.has(m[1])) visit(m[1], "function");
  };
  visit("getSiteDay", "method");
  return codes;
}

/**
 * The text of a class method's or module-level function's body, with
 * comments removed, found by its name. It throws rather than guess when a
 * string never closes or the body never ends, so a scan that lost its place
 * fails instead of reading too little.
 */
function bodyOf(source: string, name: string, kind: "method" | "function"): string {
  const head = new RegExp(
    kind === "method" ? `\\n  (?:private |public )?(?:async )?${name}\\(` : `\\n(?:export )?(?:async )?function ${name}\\(`,
  ).exec(source);
  if (!head) throw new Error(`capability.ts has no ${kind} ${name}; if it moved, revisit siteDayCodes`);
  const text = stripComments(source.slice(head.index + head[0].length));
  const lost = (what: string): never => {
    throw new Error(`could not read the body of ${name} in capability.ts (${what}); revisit bodyOf`);
  };
  // Past the parameters, then the return type, to the body's opening brace.
  let i = 0;
  for (let depth = 1; depth > 0; i++) {
    if (i >= text.length) lost("its parameters never close");
    depth += text[i] === "(" ? 1 : text[i] === ")" ? -1 : 0;
  }
  for (let angle = 0; ; i++) {
    if (i >= text.length) lost("no opening brace");
    if (text.startsWith("=>", i)) i++;
    else if (text[i] === "<") angle++;
    else if (text[i] === ">") angle--;
    else if (text[i] === "{" && angle === 0) break;
  }
  const start = i;
  for (let depth = 0; ; i++) {
    if (i >= text.length) lost("its braces never close");
    if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      for (i++; text[i] !== quote; i++) {
        if (i >= text.length) lost("a string never closes");
        if (text[i] === "\\") i++;
      }
    } else if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
}

/** Comments out, strings kept, so an apostrophe in a comment is not read as a quote. */
function stripComments(text: string): string {
  return text.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str) => str ?? "");
}

describe("every code getSiteDay can answer", () => {
  type Outcome = { problem: SiteDayProblemReason } | { setup: true } | { refusal: keyof typeof SITE_DAY_REFUSALS };
  // Each with the status the capability answers it with. A METERING_ code's
  // status is the provider's; the view reads it only for configuration.
  const OUTCOMES: Record<string, [number, Outcome]> = {
    metering_composition_disposed: [500, { refusal: "failed" }],
    metering_invalid_query: [400, { refusal: "notFound" }],
    metering_invalid_microgrid: [400, { refusal: "notFound" }],
    metering_scope_mismatch: [403, { refusal: "forbidden" }],
    metering_gate_unavailable: [503, { refusal: "unavailable" }],
    metering_disabled: [409, { refusal: "disabled" }],
    metering_timezone_unavailable: [503, { problem: "zone_unavailable" }],
    metering_invalid_date: [422, { problem: "date_out_of_range" }],
    metering_site_samples_unsupported: [503, { problem: "unsupported" }],
    metering_site_devices_unavailable: [503, { problem: "site_devices_unavailable" }],
    metering_no_site_devices: [404, { setup: true }],
    metering_site_day_failed: [500, { problem: "day_failed" }],
    METERING_CONFIGURATION: [503, { problem: "not_configured" }],
    METERING_UNAUTHORIZED: [401, { problem: "credentials_rejected" }],
    METERING_UNAVAILABLE: [503, { problem: "upstream_unavailable" }],
    METERING_INVALID_DATA: [503, { problem: "invalid_data" }],
    METERING_UNREADABLE_TIMESTAMPS: [503, { problem: "unreadable_timestamps" }],
  };

  it("are read from bodies the scan can find the end of, or it fails", () => {
    const source = "\nfunction ok(a: string): string {\n  return \"{\";\n}\nfunction open(): void {\n  const s = \"never closed;\n}\n";
    expect(bodyOf(source, "ok", "function")).toBe('{\n  return "{";\n}');
    expect(() => bodyOf(source, "open", "function")).toThrow("a string never closes");
    expect(() => bodyOf("\n  async run(): void {\n  if (x) {\n", "run", "method")).toThrow("its braces never close");
    expect(() => bodyOf(source, "missing", "method")).toThrow("capability.ts has no method missing");
  });

  it("are the codes this view has an outcome for, no more and no fewer", () => {
    expect([...siteDayCodes()].sort()).toEqual(Object.keys(OUTCOMES).sort());
  });

  it.each(Object.entries(OUTCOMES))("%s reaches its declared state", async (code, [status, outcome]) => {
    getSiteDay.mockResolvedValue({ ok: false, status, code, message: UPSTREAM });
    const out = await loadSiteDay(request("date=2026-11-01"));
    if ("refusal" in outcome) return expect(out).toEqual(SITE_DAY_REFUSALS[outcome.refusal]);
    if (!out.ok) throw new Error(`${code} was refused`);
    const data = out.model.ext?.data as { state: string; reason?: string };
    if ("setup" in outcome) return expect(data.state).toBe("no-site-devices");
    expect(data).toMatchObject({ state: "problem", reason: outcome.problem });
    expect(SITE_DAY_PROBLEM_REASONS).toContain(data.reason);
  });

  it("leave no declared reason unreached", () => {
    const reached = new Set(Object.values(OUTCOMES).flatMap(([, o]) => ("problem" in o ? [o.problem] : [])));
    // Mixed edges is configuration's 409, the synthetic provider's refusal.
    reached.add(siteDayProblem({ status: 409, code: "METERING_CONFIGURATION" })!.reason);
    expect([...reached].sort()).toEqual([...SITE_DAY_PROBLEM_REASONS].sort());
  });
});

describe("loadSiteDay's time zone notice", () => {
  const NOTICE = {
    title: "Billing timezone is still UTC",
    text: "This microgrid's address suggests Africa/Blantyre (UTC+2) but its billing timezone is UTC — set it? Billing days currently start and end at midnight UTC.",
  };
  const SET_TIMEZONE = { id: "metering.set-timezone", label: "Set timezone", href: `/microgrids/${MG}/setup/edges` };
  beforeEach(() => {
    microgrid = { data: { id: MG, name: "North site", timezone: "UTC", address_country: null, lat: null, lng: 32.6 }, error: null };
  });

  it.each([
    ["the day", () => {}],
    ["the setup state", () => getSiteDay.mockResolvedValue({ ok: false, status: 404, code: "metering_no_site_devices", message: UPSTREAM })],
    ["a problem with a fix", () => getSiteDay.mockResolvedValue({ ok: false, status: 409, code: "METERING_CONFIGURATION", message: UPSTREAM })],
    ["a problem to retry", () => getSiteDay.mockResolvedValue({ ok: false, status: 502, code: "METERING_UNAVAILABLE", message: UPSTREAM })],
  ])("carries the nudge's warning and the Set timezone link on %s", async (_, arrange) => {
    arrange();
    const out = await loadSiteDay(request());
    if (!out.ok) throw new Error("refused");
    expect((out.model.ext?.data as { timezoneNotice: unknown }).timezoneNotice).toEqual(NOTICE);
    expect(out.model.links).toContainEqual(SET_TIMEZONE);
  });

  it("carries none when the microgrid's zone is set", async () => {
    microgrid = { data: { id: MG, name: "North site", timezone: "Africa/Blantyre", address_country: null, lat: null, lng: 32.6 }, error: null };
    const out = await loadSiteDay(request());
    if (!out.ok) throw new Error("refused");
    expect((out.model.ext?.data as { timezoneNotice: unknown }).timezoneNotice).toBeNull();
    expect(out.model.links?.map((l) => l.id)).not.toContain("metering.set-timezone");
  });
});

describe("siteDayProblem", () => {
  it.each([
    [409, "METERING_CONFIGURATION", "mixed"],
    [503, "METERING_CONFIGURATION", "noConnection"],
    [422, "METERING_CONFIGURATION", "noConnection"],
    [401, "METERING_UNAUTHORIZED", "rejected"],
    [403, "METERING_UNAUTHORIZED", "rejected"],
    [503, "METERING_UNAVAILABLE", "unavailable"],
    [400, "METERING_INVALID_DATA", "invalidData"],
    [503, "METERING_INVALID_DATA", "invalidData"],
    [503, "METERING_UNREADABLE_TIMESTAMPS", "unreadableTimestamps"],
    // A source code this view does not know yet reads as the source not answering.
    [502, "METERING_UPSTREAM", "unavailable"],
    [503, "metering_site_samples_unsupported", "unsupported"],
    [503, "metering_site_devices_unavailable", "siteDevicesUnavailable"],
    [503, "metering_timezone_unavailable", "zoneUnavailable"],
    [500, "metering_site_day_failed", "dayFailed"],
    [422, "metering_invalid_date", "dateOutOfRange"],
  ] as const)("maps %i %s to %s", (status, code, problem) => {
    expect(siteDayProblem({ status, code })).toBe(SITE_DAY_PROBLEMS[problem]);
  });

  it("reads only a code's own keys, not what an object inherits", () => {
    expect(siteDayProblem({ status: 500, code: "toString" })).toBeNull();
    expect(siteDayProblem({ status: 500, code: "__proto__" })).toBeNull();
  });

  it.each([
    [409, "metering_disabled"],
    [403, "metering_forbidden"],
    [500, "metering_composition_failed"],
    [503, "metering_gate_unavailable"],
  ])("leaves %i %s to the refusals", (status, code) => {
    expect(siteDayProblem({ status, code })).toBeNull();
  });
});

describe("siteDayRefusal", () => {
  it.each([
    [409, "metering_disabled", "disabled"],
    [401, "metering_unauthenticated", "forbidden"],
    [403, "metering_forbidden", "forbidden"],
    [400, "metering_invalid_org", "notFound"],
    [404, "metering_not_found", "notFound"],
    [422, "metering_invalid_date", "notFound"],
    [500, "metering_composition_failed", "failed"],
    [503, "metering_gate_unavailable", "unavailable"],
  ] as const)("maps %i %s to %s", (status, code, refusal) => {
    expect(siteDayRefusal({ status, code })).toBe(SITE_DAY_REFUSALS[refusal]);
  });
});
