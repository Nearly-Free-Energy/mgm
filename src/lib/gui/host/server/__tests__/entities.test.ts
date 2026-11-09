import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_ENTITY_KINDS, type CoreEntityKind } from "@/lib/plugins/bundled";
import { MICROGRID_PUBLIC_COLUMNS } from "@/lib/types/microgrid-columns";
import type { EntityKind } from "../../../contract";
import type { InstallationRequest } from "../../../surface";
import type { RegisteredEntity } from "../surface-registry";

type Row = Record<string, string>;
const id = (n: number) => `e7100000-0000-4000-8001-${String(n).padStart(12, "0")}`;
const ORG_A = "e7100000-0000-4000-8000-000000000001";
const ORG_B = "e7100000-0000-4000-8000-000000000002";
const F = {
  communityA: id(1),
  communityA2: id(2),
  microgridA: id(3),
  microgridA2: id(4),
  microgridB: id(5),
  edgeA: id(6),
  edgeA2: id(7),
  deviceA2: id(8),
  periodA: id(9),
  attemptB: id(10),
  communityB: id(11),
  householdA: id(12),
  rateA: id(13),
  periodA2: id(14),
  lineItemA2: id(15),
};

/** What the caller's session can see; a missing row is one row-level security hides. */
let tables: Record<string, Record<string, Row>>;
let failing: string | null;

function seed() {
  const rows = (list: Row[]) => Object.fromEntries(list.map((r) => [r.id, r]));
  tables = {
    organizations: rows([
      { id: ORG_A, name: "Org A" },
      { id: ORG_B, name: "Org B" },
    ]),
    communities: rows([
      { id: F.communityA, name: "Community A", org_id: ORG_A },
      { id: F.communityA2, name: "Community A2", org_id: ORG_A },
      { id: F.communityB, name: "Community B", org_id: ORG_B },
    ]),
    microgrids: rows([
      { id: F.microgridA, name: "Microgrid A", community_id: F.communityA },
      { id: F.microgridA2, name: "Microgrid A2", community_id: F.communityA2 },
      { id: F.microgridB, name: "Microgrid B", community_id: F.communityB },
    ]),
    edges: rows([
      { id: F.edgeA, name: "Edge A", microgrid_id: F.microgridA },
      { id: F.edgeA2, name: "Edge A2", microgrid_id: F.microgridA2 },
    ]),
    devices: rows([{ id: F.deviceA2, name: "Meter A2", edge_id: F.edgeA2 }]),
    households: rows([{ id: F.householdA, display_name: "House 7", microgrid_id: F.microgridA }]),
    billing_periods: rows([
      { id: F.periodA, start_date: "2026-04-01", end_date: "2026-04-30", microgrid_id: F.microgridA },
      { id: F.periodA2, start_date: "2026-05-01", end_date: "2026-05-31", microgrid_id: F.microgridA },
    ]),
    billing_line_items: rows([{ id: F.lineItemA2, billing_period_id: F.periodA2 }]),
    rate_schedules: rows([{ id: F.rateA, microgrid_id: F.microgridA }]),
    payment_attempts: rows([{ id: F.attemptB, org_id: ORG_B }]),
  };
}

const PARENT: Partial<Record<CoreEntityKind, [string, string, CoreEntityKind | "org"]>> = {
  community: ["communities", "org_id", "org"],
  microgrid: ["microgrids", "community_id", "community"],
  edge: ["edges", "microgrid_id", "microgrid"],
  device: ["devices", "edge_id", "edge"],
  household: ["households", "microgrid_id", "microgrid"],
  billingPeriod: ["billing_periods", "microgrid_id", "microgrid"],
  lineItem: ["billing_line_items", "billing_period_id", "billingPeriod"],
  rateSchedule: ["rate_schedules", "microgrid_id", "microgrid"],
  paymentAttempt: ["payment_attempts", "org_id", "org"],
};

/** The gate's resolver over the same rows; like the real one, it returns an organization id unchecked. */
const resolveTargetOrganization = vi.fn(async (_s: unknown, t: { kind: CoreEntityKind; id: string }) => {
  let kind: CoreEntityKind | "org" = t.kind;
  let current = t.id;
  while (kind !== "organization" && kind !== "org") {
    const [table, column, up]: [string, string, CoreEntityKind | "org"] = PARENT[kind]!;
    if (failing === table) throw new Error("lookup failed");
    const row = tables[table]?.[current.toLowerCase()];
    if (!row) return null;
    current = row[column];
    kind = up;
  }
  return current;
});
vi.mock("@/lib/runtime/gate", () => ({
  resolveTargetOrganization: (s: unknown, t: { kind: CoreEntityKind; id: string }) => resolveTargetOrganization(s, t),
}));

import { resolveSegments, type Segment } from "../entities";
import { contextFor, managerOf, superAdmin } from "./host-fakes";

/** Column lists each table was read with. */
let selects: Record<string, string[]>;

const client = {
  from(table: string) {
    let wanted = "";
    const query = {
      select: (columns: string) => ((selects[table] ??= []).push(columns), query),
      // Postgres compares uuid values whatever their case.
      eq: (_column: string, value: string) => ((wanted = value.toLowerCase()), query),
      maybeSingle: async () =>
        failing === table
          ? { data: null, error: { message: "lookup failed" } }
          : { data: tables[table]?.[wanted] ?? null, error: null },
    };
    return query;
  },
} as unknown as SupabaseClient;

/** Every client newClient handed out; each call returns a distinct object. */
let handedOut: SupabaseClient[];
const newClient = vi.fn(async () => {
  const made = { from: client.from, n: handedOut.length } as unknown as SupabaseClient;
  handedOut.push(made);
  return made;
});
const NO_ENTITIES = { entities: new Map() };
const seg = (kind: EntityKind, segmentId: string, name: string = kind): Segment => ({ name, kind, id: segmentId });

beforeEach(() => {
  seed();
  failing = null;
  selects = {};
  handedOut = [];
  newClient.mockClear();
  resolveTargetOrganization.mockClear();
});

describe("resolveSegments", () => {
  it("resolves no segments to no organization", async () => {
    await expect(resolveSegments(contextFor([superAdmin()], newClient), NO_ENTITIES, [])).resolves.toEqual({
      ok: true,
      organizationId: null,
      scope: {},
      trail: [],
    });
    expect(newClient).not.toHaveBeenCalled();
  });

  it("resolves a nested path to its organization, with scope and trail labels", async () => {
    const result = await resolveSegments(contextFor([managerOf(ORG_A)], newClient), NO_ENTITIES, [
      seg("organization", ORG_A),
      seg("community", F.communityA),
      seg("microgrid", F.microgridA),
      seg("edge", F.edgeA),
    ]);
    expect(result).toEqual({
      ok: true,
      organizationId: ORG_A,
      scope: {
        organization: { kind: "organization", id: ORG_A, label: "Org A", href: `/organizations/${ORG_A}` },
        community: { kind: "community", id: F.communityA, label: "Community A", href: `/communities/${F.communityA}` },
        microgrid: {
          kind: "microgrid",
          id: F.microgridA,
          label: "Microgrid A",
          href: `/microgrids/${F.microgridA}/operations`,
        },
        edge: {
          kind: "edge",
          id: F.edgeA,
          label: "Edge A",
          href: `/microgrids/${F.microgridA}/setup/edges/${F.edgeA}`,
        },
      },
      trail: [
        { label: "Org A", href: `/organizations/${ORG_A}` },
        { label: "Community A", href: `/communities/${F.communityA}` },
        { label: "Microgrid A", href: `/microgrids/${F.microgridA}/operations` },
        { label: "Edge A", href: `/microgrids/${F.microgridA}/setup/edges/${F.edgeA}` },
      ],
    });
  });

  it("labels a billing period with its dates", async () => {
    const result = await resolveSegments(contextFor([managerOf(ORG_A)], newClient), NO_ENTITIES, [
      seg("microgrid", F.microgridA),
      seg("billingPeriod", F.periodA),
    ]);
    expect(result.ok && result.trail.at(-1)).toEqual({
      label: "D(2026-04-01) – D(2026-04-30)",
      href: `/microgrids/${F.microgridA}/billing/${F.periodA}`,
    });
  });

  it("labels a household with its display name and links its page", async () => {
    const result = await resolveSegments(contextFor([managerOf(ORG_A)], newClient), NO_ENTITIES, [
      seg("microgrid", F.microgridA),
      seg("household", F.householdA),
    ]);
    const household = {
      kind: "household",
      id: F.householdA,
      label: "House 7",
      href: `/microgrids/${F.microgridA}/setup/households/${F.householdA}`,
    };
    expect(result.ok && result.scope.household).toEqual(household);
    expect(result.ok && result.trail.at(-1)).toEqual({ label: household.label, href: household.href });
  });

  it("lowercases core ids, so a mixed-case path resolves the same for every caller", async () => {
    for (const roles of [[managerOf(ORG_A)], [superAdmin()]]) {
      const result = await resolveSegments(contextFor(roles, newClient), NO_ENTITIES, [
        seg("organization", ORG_A.toUpperCase()),
        seg("community", F.communityA.toUpperCase()),
        seg("microgrid", F.microgridA.toUpperCase()),
      ]);
      expect(result).toMatchObject({
        ok: true,
        organizationId: ORG_A,
        scope: { organization: { id: ORG_A }, community: { id: F.communityA }, microgrid: { id: F.microgridA } },
      });
    }
  });

  it("reads rows with enumerated columns, and microgrids only with public ones", async () => {
    const ctx = contextFor([superAdmin()], newClient);
    const one: Record<CoreEntityKind, string> = {
      organization: ORG_A,
      community: F.communityA,
      microgrid: F.microgridA,
      edge: F.edgeA,
      device: F.deviceA2,
      household: F.householdA,
      billingPeriod: F.periodA,
      lineItem: F.lineItemA2,
      rateSchedule: F.rateA,
      paymentAttempt: F.attemptB,
    };
    for (const kind of CORE_ENTITY_KINDS) {
      await expect(resolveSegments(ctx, NO_ENTITIES, [seg(kind, one[kind])])).resolves.toMatchObject({ ok: true });
    }
    for (const columns of Object.values(selects).flat()) expect(columns).not.toContain("*");
    const publicColumns = new Set(MICROGRID_PUBLIC_COLUMNS.split(", "));
    expect(selects.microgrids.length).toBeGreaterThan(0);
    for (const columns of selects.microgrids) {
      for (const column of columns.split(",").map((c) => c.trim())) expect(publicColumns).toContain(column);
    }
  });

  it("refuses segments that belong to different organizations", async () => {
    await expect(
      resolveSegments(contextFor([superAdmin()], newClient), NO_ENTITIES, [
        seg("microgrid", F.microgridA),
        seg("paymentAttempt", F.attemptB),
      ]),
    ).resolves.toEqual({ ok: false, status: 404 });
  });

  it("refuses an organization segment that is not a visible row", async () => {
    delete tables.organizations[ORG_B];
    await expect(
      resolveSegments(contextFor([superAdmin()], newClient), NO_ENTITIES, [seg("organization", ORG_B)]),
    ).resolves.toEqual({ ok: false, status: 404 });
  });

  it("refuses a segment the caller cannot see", async () => {
    delete tables.microgrids[F.microgridA];
    await expect(
      resolveSegments(contextFor([managerOf(ORG_A)], newClient), NO_ENTITIES, [seg("microgrid", F.microgridA)]),
    ).resolves.toEqual({ ok: false, status: 404 });
  });

  it("refuses an organization the caller's roles do not reach", async () => {
    await expect(
      resolveSegments(contextFor([managerOf(ORG_A)], newClient), NO_ENTITIES, [seg("organization", ORG_B)]),
    ).resolves.toEqual({ ok: false, status: 404 });
    await expect(
      resolveSegments(contextFor([managerOf(ORG_A)], newClient), NO_ENTITIES, [seg("microgrid", F.microgridB)]),
    ).resolves.toEqual({ ok: false, status: 404 });
  });

  it("refuses a segment that does not sit under the one above it", async () => {
    const ctx = contextFor([managerOf(ORG_A)], newClient);
    await expect(
      resolveSegments(ctx, NO_ENTITIES, [seg("community", F.communityA), seg("microgrid", F.microgridA2)]),
    ).resolves.toEqual({ ok: false, status: 404 });
    await expect(
      resolveSegments(ctx, NO_ENTITIES, [seg("microgrid", F.microgridA2), seg("edge", F.edgeA)]),
    ).resolves.toEqual({ ok: false, status: 404 });
  });

  // Every kind with a parent below organization: one parent it sits under, and one in the same
  // organization it does not. A community's only parent is its organization, which the
  // one-organization rule already covers.
  const NESTING: Array<[CoreEntityKind, CoreEntityKind, string, string]> = [
    ["community", "microgrid", F.communityA, F.microgridA],
    ["microgrid", "edge", F.microgridA, F.edgeA],
    ["edge", "device", F.edgeA2, F.deviceA2],
    ["microgrid", "household", F.microgridA, F.householdA],
    ["microgrid", "billingPeriod", F.microgridA, F.periodA],
    ["microgrid", "rateSchedule", F.microgridA, F.rateA],
    ["billingPeriod", "lineItem", F.periodA2, F.lineItemA2],
  ];
  const WRONG_PARENT: Partial<Record<CoreEntityKind, string>> = {
    community: F.communityA2,
    microgrid: F.microgridA2,
    edge: F.edgeA,
    billingPeriod: F.periodA,
  };

  it("covers every kind that sits under something other than an organization", () => {
    expect(new Set(NESTING.map(([, kind]) => kind))).toEqual(
      new Set(CORE_ENTITY_KINDS.filter((k) => !["organization", "community", "paymentAttempt"].includes(k))),
    );
  });

  it.each(NESTING)("checks that a %s segment holds its own %s", async (parentKind, kind, parentId, childId) => {
    const ctx = contextFor([managerOf(ORG_A)], newClient);
    await expect(
      resolveSegments(ctx, NO_ENTITIES, [seg(parentKind, parentId, "p"), seg(kind, childId, "c")]),
    ).resolves.toMatchObject({ ok: true, organizationId: ORG_A });
    await expect(
      resolveSegments(ctx, NO_ENTITIES, [seg(parentKind, WRONG_PARENT[parentKind]!, "p"), seg(kind, childId, "c")]),
    ).resolves.toEqual({ ok: false, status: 404 });
  });

  it("checks nesting across a level the path skips", async () => {
    const ctx = contextFor([managerOf(ORG_A)], newClient);
    await expect(
      resolveSegments(ctx, NO_ENTITIES, [seg("microgrid", F.microgridA), seg("device", F.deviceA2)]),
    ).resolves.toEqual({ ok: false, status: 404 });
    await expect(
      resolveSegments(ctx, NO_ENTITIES, [seg("microgrid", F.microgridA2), seg("device", F.deviceA2)]),
    ).resolves.toMatchObject({ ok: true, organizationId: ORG_A });
  });

  it("refuses an unknown kind and a malformed id before reading anything", async () => {
    const ctx = contextFor([superAdmin()], newClient);
    await expect(resolveSegments(ctx, NO_ENTITIES, [seg("vendor.site", "s1")])).resolves.toEqual({
      ok: false,
      status: 404,
    });
    await expect(resolveSegments(ctx, NO_ENTITIES, [seg("microgrid", "not-a-uuid")])).resolves.toEqual({
      ok: false,
      status: 404,
    });
    expect(newClient).not.toHaveBeenCalled();
  });

  it("resolves a plugin's own kind through its organizationOf, on a new client", async () => {
    const seen: InstallationRequest[] = [];
    const organizationOf = vi.fn(async (req: InstallationRequest, siteId: string) => {
      seen.push(req);
      return siteId === "site-a" ? ORG_A : null;
    });
    const snapshot = {
      entities: new Map<EntityKind, RegisteredEntity>([["vendor.site", { plugin: "metering", organizationOf }]]),
    };
    const ctx = contextFor([managerOf(ORG_A)], newClient);

    await expect(
      resolveSegments(ctx, snapshot, [seg("microgrid", F.microgridA, "id"), seg("vendor.site", "site-a", "site")]),
    ).resolves.toMatchObject({ ok: true, organizationId: ORG_A });
    expect(seen[0]).toMatchObject({ organizationId: null, params: { id: F.microgridA, site: "site-a" } });
    expect(newClient).toHaveBeenCalledTimes(2);
    expect(new Set(handedOut).size).toBe(2);
    const coreClients = resolveTargetOrganization.mock.calls.map(([supabase]) => supabase);
    expect(coreClients.length).toBeGreaterThan(0);
    expect(coreClients).not.toContain(seen[0].supabase);

    await expect(resolveSegments(ctx, snapshot, [seg("vendor.site", "site-b")])).resolves.toEqual({
      ok: false,
      status: 404,
    });
  });

  it("refuses a plugin segment in another organization than the core segments, in either order", async () => {
    const organizationOf = vi.fn(async (_req: InstallationRequest, siteId: string) =>
      siteId === "site-b" ? ORG_B : ORG_A,
    );
    const snapshot = {
      entities: new Map<EntityKind, RegisteredEntity>([["vendor.site", { plugin: "metering", organizationOf }]]),
    };
    const ctx = contextFor([managerOf(ORG_A)], newClient);
    await expect(
      resolveSegments(ctx, snapshot, [seg("microgrid", F.microgridA), seg("vendor.site", "site-b")]),
    ).resolves.toEqual({ ok: false, status: 404 });
    await expect(
      resolveSegments(ctx, snapshot, [seg("vendor.site", "site-b"), seg("microgrid", F.microgridA)]),
    ).resolves.toEqual({ ok: false, status: 404 });
  });

  it("refuses a context hostContext did not issue", async () => {
    const forged = { ...contextFor([superAdmin()], newClient) };
    await expect(resolveSegments(forged, NO_ENTITIES, [seg("microgrid", F.microgridA)])).rejects.toThrow(
      /did not issue/,
    );
    expect(newClient).not.toHaveBeenCalled();
  });

  it("answers 503 when a lookup fails", async () => {
    failing = "microgrids";
    await expect(
      resolveSegments(contextFor([managerOf(ORG_A)], newClient), NO_ENTITIES, [seg("microgrid", F.microgridA)]),
    ).resolves.toEqual({ ok: false, status: 503 });
  });
});
