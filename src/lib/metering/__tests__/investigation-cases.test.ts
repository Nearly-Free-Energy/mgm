/**
 * The regeneration test of #133's investigation cases
 * (docs/investigation-cases.md §1 "Rules that keep the set deterministic"):
 * each case is rebuilt from its pins through `MeteringCapability.getSiteDay`
 * and the synthetic provider, and its scenario and figures are checked
 * against §2. A pin that moves fails here.
 *
 * The stubs below stand in for the seeded installation. Each restates a fact
 * about another file, and says which; the seed's static test (A2-5) compares
 * the seed with `case-ids.ts` and `CASE_VARIANTS`, so the devices here and
 * the seeded ones come from one list.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MeteringCapability } from "../capability";
import { FixtureMeteringProvider } from "../fixture-provider";
import { MeteringRegistry } from "../registry";
import type { ManagedDevice, MeteringRepository, MeteringScope } from "../repository";
import type { SiteDayRead, TimeRange } from "../site-operations";
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

/** After every pinned date, so each is a finished day in its zone. */
const NOW = new Date("2026-11-25T00:00:00Z");

/** The microgrid number (hexadecimal) a case microgrid's UUID ends in. */
function microgridNumber(microgridId: string): string | null {
  const nn = microgridId.slice(-2);
  return CASE_VARIANTS[nn] && caseMicrogridId(nn) === microgridId ? nn : null;
}

const orgOf = (nn: string) => (CASE_VARIANTS[nn].org === "B" ? CASE_ORG_B : CASE_ORG_A);

/**
 * The microgrid's devices as `getManagedDevices` maps the seeded rows: every
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
 * role is in `HOUSE_METER_ROLES` and whose period contains the day. The
 * seed links devices 11 to 13 as primary consumption meters from 2026-01-01,
 * open-ended, so every pinned date has all three. If the role filter or the
 * seeded links change, revisit.
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
    // §1's plugin states, which the seed writes: metering is on in
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
});

describe.each(CASES)("$id", (c) => {
  it(`draws ${c.scenario} on microgrid ${c.microgrid}, ${c.date}`, () => {
    expect(siteScenario(SITE_FIXTURE_SEED, caseMicrogridId(c.microgrid), c.date)).toBe(c.scenario);
  });

  const read = c.read;
  if (c.mechanism === "pending" || read === null) {
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

  it.todo("evidence keys (A2-3)");
  it.todo("expected result (A2-12)");
});

