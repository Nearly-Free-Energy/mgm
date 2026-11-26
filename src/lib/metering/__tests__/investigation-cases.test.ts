/**
 * The regeneration test of #133's investigation cases
 * (docs/investigation-cases.md §1 "Rules that keep the set deterministic"):
 * each case is rebuilt from its pins through `MeteringCapability.getSiteDay`
 * and the synthetic provider, and its scenario and figures are checked
 * against §2; its evidence is captured through `captureSiteDay` and checked
 * against `CASE_EVIDENCE` (investigation-cases.evidence.ts). A pin that
 * moves fails here.
 *
 * The stubs below stand in for the installation docs/investigation-cases.md
 * §1 describes. Each restates §1 or another file, and says which. A2-5's
 * seed will write that installation, and its static test will compare the
 * seed with `case-ids.ts` and `CASE_VARIANTS`; until it merges, nothing
 * checks these stubs against a database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { startOfDayInZone } from "@/lib/timezone/day-key";
import { validateTimezone } from "@/lib/validation/timezone";
import { MeteringCapability } from "../capability";
import { FixtureMeteringProvider } from "../fixture-provider";
import { MeteringRegistry } from "../registry";
import type { ManagedDevice, MeteringRepository, MeteringScope } from "../repository";
import { SITE_DAY_CALC_VERSION, type SiteDayRead, type TimeRange } from "../site-operations";
import {
  meterEntries,
  resolveEvidencePointer,
  siteDayEvidenceSchema,
  type MeterReading,
  type SiteDayEvidenceRead,
  type SiteDayItemKey,
  type SiteDayWindow,
  type SummaryFigure,
} from "../site-day-evidence";
import {
  CASE_DEVICES,
  CASE_ORG_A,
  CASE_ORG_B,
  CASE_COMMUNITY_A,
  CASE_COMMUNITY_B,
  caseDeviceId,
  caseEdgeId,
  caseMicrogridId,
} from "../fixture/case-ids";
import { syntheticSupports } from "../fixture/plugin";
import { generateSiteSamples, SITE_FIXTURE_SEED, siteScenario } from "../fixture/site-samples";
import { MeteringProviderFactories } from "@/lib/runtime/services";
import {
  CASES,
  CASE_VARIANTS,
  CLEAR_DEFAULTS,
  type CaseFigures,
  type InvestigationCase,
  type MinuteRange,
} from "./investigation-cases.pins";
import {
  CASE_EVIDENCE,
  CLEAR_ITEMS,
  SUMMARY_FROM_FIGURES,
  type CaseEvidence,
  type ExpectedItem,
} from "./investigation-cases.evidence";

/** After every pinned date, so each is a finished day in its zone. */
const NOW = new Date("2026-11-25T00:00:00Z");

/** The microgrid number (hexadecimal) a case microgrid's UUID ends in. */
function microgridNumber(microgridId: string): string | null {
  const nn = microgridId.slice(-2);
  return CASE_VARIANTS[nn] && caseMicrogridId(nn) === microgridId ? nn : null;
}

const orgOf = (nn: string) => (CASE_VARIANTS[nn].org === "B" ? CASE_ORG_B : CASE_ORG_A);

/**
 * The microgrid's devices as `getManagedDevices` would map §1's rows: every
 * device on the microgrid's synthetic edge, and a legacy row's NULL
 * component id read as "" (infrastructure/supabase-repository.ts, the
 * `openems_component_id ?? ""` mapping). If that mapping changes, revisit.
 * A device on any other edge would be refused by `FixtureMeteringProvider`
 * with METERING_INVALID_DATA 400, which is not what any case expects.
 */
function managedDevices(nn: string): ManagedDevice[] {
  const variant = CASE_VARIANTS[nn];
  return CASE_DEVICES.filter((d) => !variant.omit.includes(d.dd)).map((d) => ({
    id: caseDeviceId(nn, d.dd),
    name: `Device ${d.dd}`,
    edgeId: `edge-${nn}`,
    deviceType: d.type,
    edgeOpenemsId: caseEdgeId(nn),
    componentId: variant.legacy.includes(d.dd) ? "" : d.componentId,
  }));
}

/**
 * The tenant-linked meters on any pinned date. Restates
 * `getHouseMeterIds` (infrastructure/supabase-repository.ts): links whose
 * role is in `HOUSE_METER_ROLES` and whose period contains the day. §1
 * "Devices" links devices 11 to 13 as primary consumption meters from
 * 2026-01-01, open-ended, so every pinned date has all three. If the role
 * filter or §1's links change, revisit.
 */
function houseMeterIds(nn: string): string[] {
  const variant = CASE_VARIANTS[nn];
  return CASE_DEVICES.filter((d) => d.tenantLinked && !variant.omit.includes(d.dd)).map((d) =>
    caseDeviceId(nn, d.dd)
  );
}

function stubRepository(): MeteringRepository {
  const unused = () => {
    throw new Error("Not used by a site day read");
  };
  return {
    getAuthenticatedUserId: async () => "investigations-manager",
    getUserRoles: async () => [],
    // §1's plugin states, which A2-5's seed will write: metering is on in
    // organization A and off in B, so the capability's own `requirePlugin`
    // (capability.ts) refuses C14. If §1's states change, revisit.
    isPluginEnabled: async (organizationId) => organizationId !== CASE_ORG_B,
    // §1's ownership: 0a is organization B's, every other microgrid A's.
    // Without it every read is the capability's scope mismatch (403), since
    // a case's scope is its microgrid's organization.
    getMicrogridOrganization: async (microgridId) => {
      const nn = microgridNumber(microgridId);
      if (!nn) return null;
      const orgId = orgOf(nn);
      return {
        microgridId,
        communityId: orgId === CASE_ORG_B ? CASE_COMMUNITY_B : CASE_COMMUNITY_A,
        orgId,
      };
    },
    getTenantOrganization: unused,
    getDeviceOrganization: unused,
    getStoredConnection: unused,
    // The zone as stored, unvalidated, as the repository returns it: 06's
    // `Not/AZone` reaches the capability, which falls back to UTC (C10). If
    // the repository starts validating zones, revisit.
    getMicrogridTimezone: async (microgridId) => {
      const nn = microgridNumber(microgridId);
      return nn ? CASE_VARIANTS[nn].zone : null;
    },
    getManagedDevices: async (microgridId) => {
      const nn = microgridNumber(microgridId);
      return nn ? managedDevices(nn) : [];
    },
    getHouseMeterIds: async (microgridId) => {
      const nn = microgridNumber(microgridId);
      return nn ? houseMeterIds(nn) : [];
    },
    getMicrogridEdges: unused,
    getKnownEdgeIds: unused,
    getAssignmentLinks: unused,
    insertMeterReading: unused,
    findMeterReadingAt: unused,
  };
}

/**
 * A client whose `edges` read answers as `syntheticSupports` reads it
 * (fixture/plugin.ts: `from("edges").select("openems_edge_id")
 * .eq("microgrid_id", id)`): the microgrid's synthetic edge and any extra
 * edge of its variant. If that query changes, revisit.
 */
function edgesClient(): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "edges") throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({
          eq: async (_column: string, microgridId: string) => {
            const nn = microgridNumber(microgridId);
            const ids = nn ? [caseEdgeId(nn), ...CASE_VARIANTS[nn].extraEdges] : [];
            return { data: ids.map((openems_edge_id) => ({ openems_edge_id })), error: null };
          },
        }),
      };
    },
  } as unknown as SupabaseClient;
}

/**
 * One capability per case, wired as compose.ts wires it: provider selection
 * is the root registry's `select` with the request's client, here a
 * `MeteringProviderFactories` holding the OpenEMS fallback and the synthetic
 * provider with its real `syntheticSupports`, as the platform plugins
 * register them (providers-plugin.ts, fixture/plugin.ts). If compose.ts
 * stops binding `meteringProviders.select`, revisit.
 */
function capabilityFor(c: InvestigationCase): MeteringCapability {
  const client = edgesClient();
  const factories = new MeteringProviderFactories();
  factories.register(
    "openems",
    () => {
      throw new Error("No case is read from OpenEMS");
    },
    { fallback: true }
  );
  const synthetic = () =>
    new FixtureMeteringProvider([], { siteSamples: (request) => generateSiteSamples(request) });
  factories.register("synthetic", synthetic, { supports: syntheticSupports });

  const registry = new MeteringRegistry();
  registry.register("synthetic", synthetic());
  const scope: MeteringScope = {
    organizationId: orgOf(c.microgrid),
    userId: "investigations-manager",
    roles: [],
  };
  return new MeteringCapability(
    stubRepository(),
    scope,
    registry,
    {
      testStored: async () => ({ ok: true, edgeCount: 0, edges: [] }),
      testCandidate: async () => ({ ok: true, edgeCount: 0, edges: [] }),
      discover: async () => [],
    },
    () => true,
    (microgridId) => factories.select(client, microgridId)
  );
}

/**
 * The window creation would have recorded for the case's operation
 * (evidence §3 O2): its date, in the microgrid's stored zone when valid,
 * else UTC as a fallback. It stands in for the operation's window, which
 * A2-11's step passes; if creation's zone rule changes, revisit.
 */
function RECORDED_WINDOW(c: InvestigationCase): SiteDayWindow {
  const zone = CASE_VARIANTS[c.microgrid].zone;
  return validateTimezone(zone)
    ? { date: c.date, tz: "UTC", zone: "fallback" }
    : { date: c.date, tz: zone, zone: "microgrid" };
}

const minutes = (day: SiteDayRead, ranges: TimeRange[]): MinuteRange[] =>
  ranges.map((r) => [(r.startMs - day.dayStartMs) / 60_000, (r.endMs - day.dayStartMs) / 60_000]);

function figuresOf(day: SiteDayRead): CaseFigures {
  return {
    darkMinutes: day.darkMinutes,
    darkInferredMinutes: day.darkInferredMinutes,
    noDataMinutes: day.noDataMinutes,
    knownMinutes: day.knownMinutes,
    lightsOnPct: day.lightsOnPct as number,
    cutMinutes: day.cutMinutes,
    housesEveningMetersMissing: day.housesEveningMetersMissing,
    housesEveningKwh: day.housesEveningKwh as number,
    dark: minutes(day, day.dark),
    cuts: day.cuts === null ? null : minutes(day, day.cuts),
    bins: day.soc.length,
    zone: day.read.zone,
    timezone: day.timezone,
    unreadableTimestamps: day.read.unreadableTimestamps,
    sources: day.sources,
  };
}

beforeAll(() => {
  // Only the clock: faking every timer can stall awaited provider code.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("case ids", () => {
  it("builds §1's identifiers", () => {
    expect(caseMicrogridId("0a")).toBe("00000000-0000-4000-8000-0000000c000a");
    expect(caseDeviceId("05", "13")).toBe("00000000-0000-4000-8000-0000000c0513");
    expect(caseEdgeId("09")).toBe("SYNTHETIC-EDGE-CASE-09");
    expect(caseEdgeId("0a")).toBe("SYNTHETIC-EDGE-CASE-10");
    expect(caseEdgeId("14")).toBe("SYNTHETIC-EDGE-CASE-20");
    for (const nn of ["00", "15", "1", "0A", "x1"]) expect(() => caseMicrogridId(nn)).toThrow(RangeError);
  });

  it("has a variant for each of the 20 microgrids, and every case names one", () => {
    const numbers = Array.from({ length: 20 }, (_, i) => (i + 1).toString(16).padStart(2, "0"));
    expect(Object.keys(CASE_VARIANTS).sort()).toEqual(numbers);
    expect(CASES.map((c) => c.id)).toEqual(
      Array.from({ length: 24 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`)
    );
    for (const c of CASES) expect(CASE_VARIANTS[c.microgrid], c.id).toBeDefined();
    // Only 0a is organization B's.
    expect(Object.entries(CASE_VARIANTS).filter(([, v]) => v.org === "B").map(([nn]) => nn)).toEqual(["0a"]);
  });

  it("has expected evidence for every case that exists", () => {
    // So whoever turns a case to `exists` fills its evidence in the same commit.
    const missing = CASES.filter((c) => c.mechanism === "exists" && !CASE_EVIDENCE[c.id]).map((c) => c.id);
    expect(missing).toEqual([]);
    for (const c of CASES) {
      const evidence = CASE_EVIDENCE[c.id];
      if (!evidence || !c.read) continue;
      expect(evidence.outcome === "read", c.id).toBe(c.read.ok);
    }
  });

  it("has a read for every existing case and none for a pending one", () => {
    // The type already ties them; this catches a cast or a widened type, since
    // a case that lost its read would otherwise become a todo with no failure.
    for (const c of CASES) expect(c.read !== null, c.id).toBe(c.mechanism === "exists");
  });
});

describe.each(CASES)("$id", (c) => {
  it(`draws ${c.scenario} on microgrid ${c.microgrid}, ${c.date}`, () => {
    expect(siteScenario(SITE_FIXTURE_SEED, caseMicrogridId(c.microgrid), c.date)).toBe(c.scenario);
  });

  const read = c.read;
  if (read === null) {
    it.todo("figures (A2-4)");
  } else if (read.ok) {
    it("reads the day with §2's figures, and a clear day's elsewhere", async () => {
      const result = await capabilityFor(c).getSiteDay({
        microgrid_id: caseMicrogridId(c.microgrid),
        date: c.date,
      });
      if (!result.ok) throw new Error(`Refused: ${result.status} ${result.code}`);
      const actual = figuresOf(result.data);
      const { housesEveningKwh, lightsOnPct, ...exact } = { ...CLEAR_DEFAULTS, ...read.figures };
      const { housesEveningKwh: actualKwh, lightsOnPct: actualLit, ...actualExact } = actual;
      expect(actualExact).toEqual(exact);
      expect(actualKwh).toBeCloseTo(housesEveningKwh, 3);
      expect(actualLit).toBeCloseTo(lightsOnPct, 2);
    });
  } else {
    it(`is refused with ${read.status} ${read.code}`, async () => {
      const result = await capabilityFor(c).getSiteDay({
        microgrid_id: caseMicrogridId(c.microgrid),
        date: c.date,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect({ status: result.status, code: result.code }).toEqual({ status: read.status, code: read.code });
    });
  }

  if (c.mechanism === "pending") {
    it.todo("evidence (after its scenario exists)");
  } else {
    it("captures §2's evidence", async () => {
      const evidence = CASE_EVIDENCE[c.id];
      if (!evidence) throw new Error(`${c.id} has no expected evidence`);
      await expectEvidence(c, evidence);
    });
  }
  it.todo("expected result (A2-12)");
});


const exactItem = (item: unknown): ExpectedItem => {
  const { c, reason, in: inputs } = item as { c: ExpectedItem["c"]; reason?: string; in?: string[] };
  return c === "unavailable"
    ? ({ c, reason, ...(inputs ? { in: inputs } : {}) } as ExpectedItem)
    : ({ c } as ExpectedItem);
};

/** The case's capture, checked against its expected evidence and its pins. */
async function expectEvidence(c: InvestigationCase, expected: CaseEvidence) {
  const window = RECORDED_WINDOW(c);
  const query = { microgrid_id: caseMicrogridId(c.microgrid), date: c.date };
  const capture = await capabilityFor(c).captureSiteDay(query, window);
  expect(capture.outcome).toBe(expected.outcome);
  if (capture.outcome === "access_refused") throw new Error(`${c.id} was refused access`);
  expect(siteDayEvidenceSchema.safeParse(capture.snapshot).success).toBe(true);
  const snapshot = capture.snapshot;
  expect(snapshot.by.calc).toBe(SITE_DAY_CALC_VERSION);
  expect(snapshot.window.date).toBe(c.date);

  if (expected.outcome === "refused") {
    if (capture.outcome !== "refused") throw new Error("not refused");
    const refused = capture.snapshot;
    const items = Object.fromEntries(Object.entries(refused.items).filter(([key]) => key !== "read"));
    expect(Object.fromEntries(Object.entries(items).map(([key, item]) => [key, exactItem(item)]))).toEqual(
      expected.items
    );
    expect(refused.items.read).toEqual({ c: "unavailable", k: "read", ...expected.read });
    expect(refused.by.provider).toBe(expected.provider);
    expect(capture.zoneRead).toEqual(expected.zoneRead);
    expect({ tz: refused.window.tz, zone: refused.window.zone }).toEqual(expected.window);
    expect(refused.window.caveat !== undefined).toBe(expected.window.zone === "fallback");
    return;
  }

  if (capture.outcome !== "read" || !c.read?.ok) throw new Error("not read");
  const s: SiteDayEvidenceRead = capture.snapshot;
  const pins = { ...CLEAR_DEFAULTS, ...c.read.figures };

  // Keys and kinds: CLEAR_ITEMS with the case's changes, and timestamps from the pins.
  const kinds: Partial<Record<SiteDayItemKey, ExpectedItem>> = {};
  for (const [key, item] of Object.entries({ ...CLEAR_ITEMS, ...expected.items })) {
    if (item) kinds[key as SiteDayItemKey] = item;
  }
  kinds.timestamps =
    pins.unreadableTimestamps === null ? { c: "unavailable", reason: "not_reported" } : { c: "fact" };
  expect(Object.keys(s.items).sort()).toEqual(Object.keys(kinds).sort());
  for (const [key, item] of Object.entries(s.items)) {
    expect(exactItem(item), key).toEqual(kinds[key as SiteDayItemKey]);
  }
  if (pins.unreadableTimestamps !== null) {
    expect(s.items.timestamps).toEqual({ c: "fact", k: "timestamps", dropped: pins.unreadableTimestamps });
  }

  // Window, from the pins.
  expect(s.window).toMatchObject({ tz: pins.timezone, zone: pins.zone, bins: pins.bins, res: 5 });
  expect(s.window.caveat !== undefined).toBe(pins.zone === "fallback");
  expect(s.window.t0).toBe(startOfDayInZone(c.date, pins.timezone).getTime());

  // Ranges and what decided them, each pointer resolving to its value.
  for (const key of ["dark_cut", "dark_lowbat", "dark_after_lowbat", "no_data"] as const) {
    const item = s.items[key];
    if (item?.c !== "calculated") {
      expect(expected.ranges?.[key], key).toBeUndefined();
      continue;
    }
    expect(item.ranges, key).toEqual(expected.ranges?.[key]);
    if (item.k === "no_data") {
      expect(item.ruledOut.map((r) => ({ grid: r.grid?.ptr ?? null, soc: r.soc?.ptr ?? null }))).toEqual(
        expected.ruledOut
      );
      for (const r of item.ruledOut) {
        for (const p of [r.grid, r.soc]) if (p) expect(resolveEvidencePointer(s, p.ptr)).toBe(p.v);
      }
    } else {
      expect(item.decidedBy.map((p) => p.ptr)).toEqual(expected.decidedBy?.[key as Exclude<typeof key, "no_data">]);
      for (const p of item.decidedBy) {
        const at = resolveEvidencePointer(s, p.ptr);
        if ("v" in p) expect(at).toBe(p.v);
        else expect(Array.isArray(at)).toBe(true);
      }
    }
  }

  // Summary: the pinned figures, with rule Z's nulls.
  const nulls = new Set(expected.nullFigures ?? []);
  for (const [figure, field] of Object.entries(SUMMARY_FROM_FIGURES) as [SummaryFigure, keyof typeof pins][]) {
    const stored = s.items.summary[figure];
    if (nulls.has(figure)) expect(stored, figure).toBeNull();
    else if (figure === "tenantMetersEveningKwh") expect(stored as number).toBeCloseTo(pins[field] as number, 3);
    else if (figure === "lightsOnPct") expect(stored as number).toBeCloseTo(pins[field] as number, 2);
    else expect(stored, figure).toEqual(pins[field]);
  }

  // Meters: the window, each reading's component, the outcomes and the unreadable meters.
  expect(s.items.meter_window).toEqual({
    c: "calculated",
    k: "meter_window",
    ...(expected.meterWindow ?? { start: [209, 216], end: [281, 287] }),
  });
  const variant = CASE_VARIANTS[c.microgrid];
  for (const [id, reading] of meterEntries<MeterReading>(s.items.meter_readings)) {
    const dd = id.slice(-2);
    expect(id).toBe(caseDeviceId(c.microgrid, dd));
    expect(reading.component).toBe(CASE_DEVICES.find((d) => d.dd === dd)?.componentId);
    const pinned = expected.meterReadings?.[dd as "11"];
    if (pinned) expect({ start: reading.start, end: reading.end }).toEqual(pinned);
  }
  const readable = CASE_DEVICES.filter(
    (d) => d.tenantLinked && !variant.omit.includes(d.dd) && !variant.legacy.includes(d.dd)
  ).map((d) => caseDeviceId(c.microgrid, d.dd));
  expect(meterEntries(s.items.meter_readings).map(([id]) => id)).toEqual(readable);
  expect(Object.fromEntries(meterEntries<string>(s.items.meter_outcomes).map(([id, o]) => [id.slice(-2), o]))).toEqual(
    expected.meterOutcomes ?? {}
  );
  const devices = (list: string[] | undefined) => (list ?? []).map((dd) => caseDeviceId(c.microgrid, dd));
  expect(s.items.m_unreadable?.devices ?? []).toEqual(devices(expected.unreadable?.tenant_meter_unreadable));
  expect(s.items.m_id_not_storable?.devices ?? []).toEqual(devices(expected.unreadable?.id_not_storable));

  expect(capture.zoneRead).toEqual({ tz: pins.timezone, zone: pins.zone });
  expect(capture.endedBeforeDay).toBe(false);

  // The same figures as the page's read of the day.
  const page = await capabilityFor(c).getSiteDay(query);
  if (!page.ok) throw new Error(`Refused: ${page.status} ${page.code}`);
  const figures = figuresOf(page.data);
  for (const [figure, field] of Object.entries(SUMMARY_FROM_FIGURES) as [SummaryFigure, keyof CaseFigures][]) {
    const stored = s.items.summary[figure];
    if (stored !== null) expect(stored, figure).toBe(figures[field]);
  }
}
