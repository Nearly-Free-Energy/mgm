import { inspect } from "node:util";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreEntityKind, MgmPluginName } from "@/lib/plugins/bundled";
import type { Id } from "../../../contract";
import type { Fmt } from "../../../surface";
import { hostContext } from "../access";
import type { RegisteredStatus, SurfaceSnapshot } from "../surface-registry";

const checkGate = vi.fn();
const resolveTargetOrganization = vi.fn();
vi.mock("@/lib/runtime/gate", () => ({
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: (...args: unknown[]) => resolveTargetOrganization(...args),
}));
let snapshot: SurfaceSnapshot;
const takeSnapshot = vi.fn(() => snapshot);
vi.mock("@/lib/runtime/root", () => ({ getMgmRuntime: async () => ({ mgmSurface: { snapshot: () => takeSnapshot() } }) }));
const getRequestUserAccess = vi.fn();
vi.mock("@/lib/auth/request-access", () => ({ getRequestUserAccess: () => getRequestUserAccess() }));
const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "accept-language": "en-UG" }) }));

import { STATUS_BUDGET_MS, buildManifest, getManifest, preloadManifest, readManifestQuery, serveManifest } from "../manifest";
import { ORG_A, ORG_B, contextFor, managerOf, superAdmin, tableClient, tenantHomes, tenantOf } from "./host-fakes";
import { BROWSER } from "@/lib/runtime/caller";

const COMMUNITY = "e7100000-0000-4000-8001-000000000001";
const MICROGRID_A = "e7100000-0000-4000-8001-000000000002";
const MICROGRID_X = "e7100000-0000-4000-8001-000000000003";

const legacy = (plugin: MgmPluginName, id: Id, href: `/${string}`, needs: CoreEntityKind[]) => ({
  plugin,
  def: { id, title: id, icon: "billing" as const, group: "money" as const, order: 1, href, needs, legacy: true as const },
});

function snapshotWith(over: Partial<SurfaceSnapshot> = {}): SurfaceSnapshot {
  return {
    views: [],
    actions: new Map(),
    nav: [
      legacy("billing", "billing.periods", "/microgrids/[id]/billing", ["microgrid"]),
      legacy("organization-directory", "org.users", "/settings/users", []),
      { ...legacy("organization-directory", "org.organizations", "/organizations", []), def: { ...legacy("organization-directory", "org.organizations", "/organizations", []).def, audience: "super-admin" as const } },
    ],
    signals: [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
    ...over,
  };
}

const status = (plugin: MgmPluginName, id: Id, load: RegisteredStatus["load"]): RegisteredStatus => ({ plugin, id, load });

function tables(organizations = [{ id: ORG_A, name: "Org A" }]) {
  return tableClient({
    organizations: { data: organizations },
    user_profiles: { data: [{ first_name: " Ada ", last_name: "Okello" }] },
    communities: { data: [{ id: COMMUNITY, name: "Community A" }] },
    microgrids: { data: [{ id: MICROGRID_A, name: "Microgrid A", community_id: COMMUNITY, timezone: "Africa/Kampala" }] },
  });
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  snapshot = snapshotWith();
  takeSnapshot.mockClear();
  checkGate.mockReset().mockResolvedValue({ ok: true, organizationId: ORG_A });
  resolveTargetOrganization.mockReset();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
  vi.useRealTimers();
});

describe("buildManifest", () => {
  it("builds the manifest of the person's one organization, reading through their own session", async () => {
    const { client, calls } = tables();
    const newClient = vi.fn(async () => client);
    const outcome = await buildManifest(contextFor([managerOf(ORG_A)], newClient), { gui: "gridtop" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.manifest).toMatchObject({
      release: null,
      locale: "en-UG",
      now: "2026-11-09T08:00:00.000Z",
      gui: "gridtop",
      user: { name: "Ada Okello", email: "host@test.local" },
      org: {
        id: ORG_A,
        name: "Org A",
        timezone: "Africa/Kampala",
        places: [
          { kind: "community", id: COMMUNITY },
          { kind: "microgrid", id: MICROGRID_A, parent: COMMUNITY },
        ],
      },
      orgs: [{ id: ORG_A, name: "Org A" }],
    });
    expect(outcome.manifest.org.nav.map((n) => n.href)).toEqual(["/microgrids/[microgrid]/billing", "/settings/users"]);
    // Places are read with enumerated columns, scoped to the organization; the
    // inner join makes the community filter drop microgrid rows, not just the embed.
    const communities = calls.find((c) => c.table === "communities")!;
    expect(communities.ops).toContainEqual(["eq", ["org_id", ORG_A]]);
    const microgrids = calls.find((c) => c.table === "microgrids")!;
    expect(microgrids.ops).toContainEqual(["eq", ["communities.org_id", ORG_A]]);
    expect(String(microgrids.ops[0][1][0])).toContain("communities!inner(org_id)");
    expect(String(microgrids.ops[0][1][0])).not.toContain("*");
    expect(checkGate).toHaveBeenCalledWith(client, expect.objectContaining({ target: { kind: "organization", id: ORG_A } }));
    // The name is the signed-in person's own profile row.
    const profile = calls.find((c) => c.table === "user_profiles")!;
    expect(profile.ops).toContainEqual(["eq", ["user_id", "e7100000-0000-4000-8fff-000000000001"]]);
    expect(profile.ops).toContainEqual(["maybeSingle", []]);
  });

  it("shows super-admin entries to super admins only", async () => {
    const { client } = tables();
    const ids = async (roles: Parameters<typeof contextFor>[0]) => {
      const outcome = await buildManifest(contextFor(roles, async () => client), { gui: "gridtop" });
      return outcome.ok ? outcome.manifest.org.nav.map((n) => n.id) : [];
    };
    expect(await ids([managerOf(ORG_A)])).not.toContain("org.organizations");
    expect(await ids([superAdmin()])).toContain("org.organizations");
  });

  it("keeps the person to their name and email", async () => {
    const { client } = tables();
    const user = { id: "u1", email: "ada@test.local", phone: "+256700000000", app_metadata: { provider: "email" }, identities: [] };
    const made = hostContext({ user: user as unknown as User, roles: [managerOf(ORG_A)] }, new Headers(), {
      newClient: async () => client,
      makeFmt: () => ({}) as Fmt,
      caller: BROWSER,
    });
    if (!made.ok) throw new Error("context refused");
    const outcome = await buildManifest(made.ctx, { gui: "gridtop" });
    expect(outcome.ok && outcome.manifest.user).toStrictEqual({ name: "Ada Okello", email: "ada@test.local" });
  });

  it("acts in ?org= for a person who sees two organizations, and in the path's organization before that", async () => {
    const { client } = tables([
      { id: ORG_A, name: "Org A" },
      { id: ORG_B, name: "Org B" },
    ]);
    const ctx = contextFor([superAdmin()], async () => client);
    const requested = await buildManifest(ctx, { gui: "gridtop", requested: ORG_B });
    expect(requested.ok && [requested.manifest.org.id, requested.manifest.orgs.length]).toEqual([ORG_B, 2]);

    resolveTargetOrganization.mockResolvedValue(ORG_A);
    const fromPath = await buildManifest(ctx, { gui: "gridtop", path: `/microgrids/${MICROGRID_A}/billing`, requested: ORG_B });
    expect(fromPath.ok && fromPath.manifest.org.id).toBe(ORG_A);
    expect(resolveTargetOrganization).toHaveBeenCalledWith(client, { kind: "microgrid", id: MICROGRID_A });
  });

  it("reads the gate, places and status of the organization ?org= picks, not the first", async () => {
    const { client, calls } = tables([
      { id: ORG_A, name: "Org A" },
      { id: ORG_B, name: "Org B" },
    ]);
    const seen: unknown[] = [];
    snapshot = snapshotWith({
      status: [status("billing", "billing.due", async (req) => (seen.push(req.organizationId), null))],
    });
    // Billing is off in Org A only.
    checkGate.mockImplementation(async (_s, { plugin, target }) =>
      plugin === "billing" && target.id === ORG_A
        ? { ok: false, status: 409, code: "billing_disabled", message: "off" }
        : { ok: true, organizationId: target.id },
    );
    const outcome = await buildManifest(contextFor([superAdmin()], async () => client), { gui: "gridtop", requested: ORG_B });
    expect(outcome.ok && outcome.manifest.org.nav.map((n) => n.id)).toContain("billing.periods");
    const targets = checkGate.mock.calls.map(([, r]) => r.target.id);
    expect(new Set(targets)).toEqual(new Set([ORG_B]));
    expect(calls.find((c) => c.table === "communities")!.ops).toContainEqual(["eq", ["org_id", ORG_B]]);
    expect(calls.find((c) => c.table === "microgrids")!.ops).toContainEqual(["eq", ["communities.org_id", ORG_B]]);
    expect(seen).toEqual([ORG_B]);
  });

  it("leaves out the path's places when the path is not in the chosen organization", async () => {
    // Row-level security shows Org B only; the path's microgrid resolves to Org A.
    const { client } = tables([{ id: ORG_B, name: "Org B" }]);
    resolveTargetOrganization.mockResolvedValue(ORG_A);
    const ctx = contextFor([superAdmin()], async () => client);
    const outcome = await buildManifest(ctx, { gui: "gridtop", path: `/microgrids/${MICROGRID_X}/billing` });
    expect(outcome.ok && outcome.manifest.org.id).toBe(ORG_B);
    expect(outcome.ok && outcome.manifest.org.places.map((p) => p.id)).not.toContain(MICROGRID_X);
  });

  it("gives the path's microgrid its community, reading it when the microgrid is past the places cap", async () => {
    const { client, calls } = tables();
    resolveTargetOrganization.mockResolvedValue(ORG_A);
    const ctx = contextFor([managerOf(ORG_A)], async () => client);
    const listed = await buildManifest(ctx, { gui: "gridtop", path: `/microgrids/${MICROGRID_A}/billing` });
    expect(listed.ok && listed.manifest.org.places.filter((p) => p.id === MICROGRID_A)).toEqual([
      expect.objectContaining({ parent: COMMUNITY }),
    ]);
    expect(calls.filter((c) => c.table === "microgrids")).toHaveLength(2); // the path's row and the list

    calls.length = 0;
    const beyond = await buildManifest(ctx, { gui: "gridtop", path: `/microgrids/${MICROGRID_X}/billing` });
    // The fake answers every microgrid read with Microgrid A's row, so only the id is the path's.
    expect(beyond.ok && beyond.manifest.org.places.at(-1)).toMatchObject({ kind: "microgrid", id: MICROGRID_X, parent: COMMUNITY });
    const read = calls.filter((c) => c.table === "microgrids").at(-1)!;
    expect(read.ops).toEqual([
      ["select", ["community_id, communities(name)"]],
      ["eq", ["id", MICROGRID_X]],
      ["maybeSingle", []],
    ]);

    // A listed microgrid whose community is past the cap brings that community along.
    const far = "e7100000-0000-4000-8001-000000000009";
    const { client: farClient } = tableClient({
      organizations: { data: [{ id: ORG_A, name: "Org A" }] },
      communities: { data: [{ id: COMMUNITY, name: "Community A" }] },
      microgrids: { data: [{ id: MICROGRID_A, name: "Microgrid A", community_id: far, timezone: null, communities: { name: "Far" } }] },
    });
    const farOut = await buildManifest(contextFor([managerOf(ORG_A)], async () => farClient), {
      gui: "gridtop",
      path: `/microgrids/${MICROGRID_A}/billing`,
    });
    expect(farOut.ok && farOut.manifest.org.places).toContainEqual({ kind: "community", id: far, label: "Far", href: `/communities/${far}` });
  });

  it("refuses a person who can see no organization", async () => {
    const { client } = tables([]);
    await expect(buildManifest(contextFor([managerOf(ORG_A)], async () => client), { gui: "gridtop" })).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: "gui_no_access",
    });
  });

  it("leaves out the nav and status of a plugin the gate refuses, without running its loader", async () => {
    const { client } = tables();
    const load = vi.fn();
    snapshot = snapshotWith({ status: [status("billing", "billing.due", load)] });
    checkGate.mockImplementation(async (_s, { plugin }) =>
      plugin === "billing" ? { ok: false, status: 409, code: "billing_disabled", message: "off" } : { ok: true, organizationId: ORG_A },
    );
    const outcome = await buildManifest(contextFor([managerOf(ORG_A)], async () => client), { gui: "gridtop" });
    expect(outcome.ok && outcome.manifest.org.nav.map((n) => n.id)).toEqual(["org.users"]);
    expect(load).not.toHaveBeenCalled();
  });

  it("gives each status loader its own request for the organization and keeps what passes", async () => {
    const { client } = tables();
    const seen: unknown[] = [];
    snapshot = snapshotWith({
      status: [
        status("billing", "billing.due", async (req) => {
          seen.push(req.organizationId);
          return { label: "Due", state: "needs-you", open: "/microgrids", ask: undefined, extra: "dropped" } as never;
        }),
        status("billing", "billing.none", async () => null),
        status("metering", "metering.throws", async () => {
          throw new Error("canary-text");
        }),
        status("metering", "metering.bad", async () => ({ label: "Bad", state: "unknown", open: "/microgrids" }) as never),
        status("metering", "metering.unreleased", async () => ({ label: "Elsewhere", state: "idle", open: "/microgrids/x/unreleased" })),
        status("metering", "metering.undefined", async () => undefined as never),
      ],
    });
    const newClient = vi.fn(async () => client);
    const outcome = await buildManifest(contextFor([managerOf(ORG_A)], newClient), { gui: "gridtop" });
    expect(outcome.ok && outcome.manifest.org.status).toEqual([{ id: "billing.due", label: "Due", state: "needs-you", open: "/microgrids" }]);
    expect(seen).toEqual([ORG_A]);
    expect(inspect(errors.mock.calls, { depth: 5 })).not.toContain("canary-text");
  });

  it("leaves out a status item whose loader is late", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client } = tables();
    snapshot = snapshotWith({ status: [status("billing", "billing.slow", () => new Promise(() => {}))] });
    const pending = buildManifest(contextFor([managerOf(ORG_A)], async () => client), { gui: "gridtop" });
    await vi.advanceTimersByTimeAsync(STATUS_BUDGET_MS);
    const outcome = await pending;
    expect(outcome.ok && outcome.manifest.org.status).toEqual([]);
  });

  it("throws rather than send a manifest its schema refuses", async () => {
    const { client } = tables();
    await expect(buildManifest(contextFor([managerOf(ORG_A)], async () => client), { gui: "" })).rejects.toThrow(
      "GUI host: the manifest failed its schema",
    );
  });

  it("refuses a context hostContext did not issue, before reading anything", async () => {
    const newClient = vi.fn(async () => tables().client);
    await expect(buildManifest({ ...contextFor([superAdmin()], newClient) }, { gui: "gridtop" })).rejects.toThrow(/did not issue/);
    expect(takeSnapshot).not.toHaveBeenCalled();
    expect(newClient).not.toHaveBeenCalled();
  });
});

describe("buildManifest for a person who holds units", () => {
  const UNIT_A = "e7400000-0000-4000-8000-00000000000a";
  const UNIT_B = "e7400000-0000-4000-8000-00000000000b";
  const tenantHome = {
    plugin: "tenant-app" as const,
    def: { id: "tenant.home" as const, title: "My home", icon: "tenants" as const, group: "operate" as const, order: 80, view: "tenant.home" as const, audience: "tenant" as const },
  };
  const HOMES = tenantHomes([
    { id: UNIT_A, name: "Grace Namata", unitLabel: "Unit 4", orgId: ORG_A, timezone: "Africa/Kampala" },
    { id: UNIT_B, name: "Shop 9", orgId: ORG_B, timezone: "Africa/Nairobi" },
  ]);

  function withTenantApp(over: Partial<SurfaceSnapshot> = {}) {
    snapshot = snapshotWith({
      nav: [...snapshotWith().nav, tenantHome],
      views: [{ plugin: "tenant-app", def: { id: "tenant.home", path: "/my", params: {} } } as unknown as SurfaceSnapshot["views"][number]],
      ...over,
    });
  }

  /** The tenant app on in `on` only; every other plugin on everywhere. */
  function tenantAppOnIn(...on: string[]) {
    checkGate.mockImplementation(async (_s, { plugin, target }) =>
      plugin === "tenant-app" && !on.includes(target.id)
        ? { ok: false, status: 409, code: "tenant_app_disabled", message: "off" }
        : { ok: true, organizationId: target.id },
    );
  }

  function clientFor(organizations: { id: string; name: string }[] = []) {
    return tableClient(
      {
        organizations: { data: organizations },
        user_profiles: { data: [{ first_name: "Grace", last_name: "Namata" }] },
        communities: { data: [{ id: COMMUNITY, name: "Community A" }] },
        microgrids: { data: [{ id: MICROGRID_A, name: "Microgrid A", community_id: COMMUNITY, timezone: "Africa/Kampala" }] },
      },
      HOMES,
    );
  }

  beforeEach(() => {
    withTenantApp();
    tenantAppOnIn(ORG_A, ORG_B);
  });

  it("builds a tenant-only person's manifest from their one unit, and nothing of an organization", async () => {
    const { client, calls } = clientFor();
    const newClient = vi.fn(async () => client);
    const outcome = await buildManifest(contextFor([tenantOf(UNIT_A)], newClient), { gui: "gridtop", path: "/" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.manifest.user).toEqual({ name: "Grace Namata", email: "host@test.local" });
    expect(outcome.manifest.org).toEqual({
      id: UNIT_A,
      // The unit label; "Grace Namata" is the tenant's own name.
      name: "Unit 4",
      href: "/my",
      timezone: "Africa/Kampala",
      nav: [expect.objectContaining({ id: "tenant.home", href: "/my" })],
      status: [],
      places: [{ kind: "tenant", id: UNIT_A, label: "Unit 4", href: "/my" }],
    });
    expect(outcome.manifest.orgs).toEqual([]);
    // The unit through fn_tenant_home on the person's own session; no
    // organization, community or microgrid read, and no path resolved.
    expect(calls.map((c) => c.table).sort()).toEqual(["rpc:fn_tenant_home", "user_profiles"]);
    expect(calls.find((c) => c.table === "rpc:fn_tenant_home")!.ops).toEqual([["rpc", [{ _tenant_id: UNIT_A }]]]);
    expect(resolveTargetOrganization).not.toHaveBeenCalled();
    // The gate of the unit's organization, asked with that same session.
    expect(new Set(checkGate.mock.calls.map(([supabase, r]) => [supabase, r.target.id]).map(String))).toEqual(
      new Set([String([client, ORG_A])]),
    );
    expect(checkGate).toHaveBeenCalledWith(client, expect.objectContaining({ plugin: "tenant-app", target: { kind: "organization", id: ORG_A } }));
  });

  it("shows no tenant entry while the tenant app is off for the unit's organization, and runs no status loader", async () => {
    const load = vi.fn();
    withTenantApp({ status: [status("billing", "billing.due", load)] });
    tenantAppOnIn(ORG_B);
    const { client } = clientFor();
    const outcome = await buildManifest(contextFor([tenantOf(UNIT_A)], async () => client), { gui: "gridtop" });
    expect(outcome.ok && outcome.manifest.org.nav).toEqual([]);
    expect(outcome.ok && outcome.manifest.org.status).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("gives a person with two units both as places, in the unit the path names, else the last used, else the first", async () => {
    const { client } = clientFor();
    const ctx = contextFor([tenantOf(UNIT_B), tenantOf(UNIT_A)], async () => client);
    const named = await buildManifest(ctx, { gui: "gridtop", path: `/my?unit=${UNIT_B}` });
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(named.manifest.org).toMatchObject({ id: UNIT_B, name: "Shop 9", href: `/my?unit=${UNIT_B}`, timezone: "Africa/Nairobi" });
    expect(named.manifest.org.places).toEqual([
      { kind: "tenant", id: UNIT_B, label: "Shop 9", href: `/my?unit=${UNIT_B}` },
      { kind: "tenant", id: UNIT_A, label: "Unit 4", href: `/my?unit=${UNIT_A}` },
    ]);
    // Each unit's organization's gate, once each.
    expect(new Set(checkGate.mock.calls.map(([, r]) => r.target.id))).toEqual(new Set([ORG_A, ORG_B]));

    const preferred = await buildManifest(ctx, { gui: "gridtop", path: "/my", preferred: UNIT_B });
    expect(preferred.ok && preferred.manifest.org.id).toBe(UNIT_B);
    // The first by label ("Shop 9" before "Unit 4"); neither organization hint names a unit.
    const first = await buildManifest(ctx, { gui: "gridtop", path: "/my", preferred: ORG_A, requested: UNIT_A });
    expect(first.ok && first.manifest.org.id).toBe(UNIT_B);
  });

  it("shows the tenant entry when the tenant app is on for any of the person's units", async () => {
    tenantAppOnIn(ORG_B);
    const { client } = clientFor();
    const outcome = await buildManifest(contextFor([tenantOf(UNIT_A), tenantOf(UNIT_B)], async () => client), { gui: "gridtop" });
    expect(outcome.ok && outcome.manifest.org.nav.map((n) => n.id)).toEqual(["tenant.home"]);
  });

  it("gives a person with staff and tenant rows the organization's manifest with both groups", async () => {
    // Manager of Org B, tenant in Org A: the tenant app is on in Org A only.
    tenantAppOnIn(ORG_A);
    const { client, calls } = clientFor([{ id: ORG_B, name: "Org B" }]);
    const outcome = await buildManifest(contextFor([managerOf(ORG_B), tenantOf(UNIT_A)], async () => client), { gui: "gridtop" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.manifest.org).toMatchObject({ id: ORG_B, name: "Org B", href: `/organizations/${ORG_B}` });
    expect(outcome.manifest.org.nav.map((n) => n.id)).toEqual(["tenant.home", "billing.periods", "org.users"]);
    // The organization's places only; a unit is not one of them.
    expect(outcome.manifest.org.places.map((p) => p.kind)).toEqual(["community", "microgrid"]);
    expect(calls.filter((c) => c.table === "rpc:fn_tenant_home")).toHaveLength(1);

    // The tenant app on in the organization they manage but not where they rent.
    tenantAppOnIn(ORG_B);
    const elsewhere = await buildManifest(contextFor([managerOf(ORG_B), tenantOf(UNIT_A)], async () => client), { gui: "gridtop" });
    expect(elsewhere.ok && elsewhere.manifest.org.nav.map((n) => n.id)).toEqual(["billing.periods", "org.users"]);
  });

  it("still builds a staff manifest when a unit cannot be read, without the tenant entries", async () => {
    const { client } = tableClient(
      {
        organizations: { data: [{ id: ORG_B, name: "Org B" }] },
        communities: { data: [] },
        microgrids: { data: [] },
      },
      { fn_tenant_home: () => ({ data: null, error: { message: "unavailable" } }) },
    );
    const outcome = await buildManifest(contextFor([managerOf(ORG_B), tenantOf(UNIT_A)], async () => client), { gui: "gridtop" });
    expect(outcome.ok && outcome.manifest.org.nav.map((n) => n.id)).toEqual(["billing.periods", "org.users"]);
  });

  it("tells apart two units that share the tenant's name, in places and in the context", async () => {
    // One person's two units, each named only by the tenant's own name.
    const { client } = tableClient(
      { user_profiles: { data: [] } },
      tenantHomes([
        { id: UNIT_A, name: "Grace Namata", orgId: ORG_A, microgrid: "Kasana East" },
        { id: UNIT_B, name: "Grace Namata", orgId: ORG_B, microgrid: "Kiwumu" },
      ]),
    );
    const outcome = await buildManifest(contextFor([tenantOf(UNIT_A), tenantOf(UNIT_B)], async () => client), {
      gui: "gridtop",
      path: `/my?unit=${UNIT_B}`,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.manifest.org.name).toBe("Grace Namata · Kiwumu");
    expect(outcome.manifest.org.places.map((p) => p.label)).toEqual(["Grace Namata · Kasana East", "Grace Namata · Kiwumu"]);
  });

  it("builds a tenant-only person's manifest from the units that can be read when one cannot", async () => {
    const { client } = tableClient(
      { user_profiles: { data: [] } },
      {
        fn_tenant_home: (args: Record<string, unknown>) =>
          args._tenant_id === UNIT_A ? { data: null, error: { message: "unavailable" } } : HOMES.fn_tenant_home(args),
      },
    );
    const outcome = await buildManifest(contextFor([tenantOf(UNIT_A), tenantOf(UNIT_B)], async () => client), { gui: "gridtop" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The person still holds two units, so the link names the one it is for:
    // a bare /my would ask them to choose (chooseTenantUnit counts role rows).
    expect(outcome.manifest.org).toMatchObject({ id: UNIT_B, name: "Shop 9", href: `/my?unit=${UNIT_B}` });
    expect(outcome.manifest.org.places.map((p) => [p.id, p.href])).toEqual([[UNIT_B, `/my?unit=${UNIT_B}`]]);
  });

  it("fails a tenant-only person's manifest when a unit cannot be read", async () => {
    const { client } = tableClient({}, { fn_tenant_home: () => ({ data: null, error: { message: "unavailable" } }) });
    await expect(buildManifest(contextFor([tenantOf(UNIT_A)], async () => client), { gui: "gridtop" })).rejects.toThrow(
      "a unit could not be read",
    );
  });

  it("refuses a tenant-only person none of whose units answers any more", async () => {
    const { client } = tableClient({}, tenantHomes([]));
    await expect(buildManifest(contextFor([tenantOf(UNIT_A)], async () => client), { gui: "gridtop" })).resolves.toMatchObject({
      ok: false,
      status: 403,
      code: "gui_no_access",
    });
  });

  it("does not resolve a staff path's places for a tenant-only person", async () => {
    const { client } = clientFor();
    const outcome = await buildManifest(contextFor([tenantOf(UNIT_A)], async () => client), {
      gui: "gridtop",
      path: `/microgrids/${MICROGRID_A}/billing`,
    });
    expect(outcome.ok && outcome.manifest.org.id).toBe(UNIT_A);
    expect(resolveTargetOrganization).not.toHaveBeenCalled();
  });
});

describe("getManifest", () => {
  it("answers 401 without a user, before reading anything", async () => {
    getRequestUserAccess.mockResolvedValue({ user: null, roles: [] });
    await expect(getManifest("gridtop", null, null, null)).resolves.toMatchObject({ ok: false, status: 401 });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("builds on clients of the request's session", async () => {
    const { client } = tables();
    createClient.mockResolvedValue(client as SupabaseClient);
    getRequestUserAccess.mockResolvedValue({ user: { id: "u1", email: "ada@test.local" }, roles: [managerOf(ORG_A)] });
    const outcome = await getManifest("gridtop", "/settings/users", null, null);
    expect(outcome.ok && outcome.manifest.user).toEqual({ name: "Ada Okello", email: "ada@test.local" });
    expect(createClient).toHaveBeenCalled();
  });

  it("starts the reads when preloaded", async () => {
    getRequestUserAccess.mockReset().mockResolvedValue({ user: null, roles: [] });
    preloadManifest("gridtop", "/settings/profile", null, null);
    expect(getRequestUserAccess).toHaveBeenCalledTimes(1);
  });
});

describe("serveManifest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the manifest with the interface this installation renders, and the hints given", async () => {
    vi.stubEnv("MGM_GUI", "gridtop");
    const { client } = tables([{ id: ORG_A, name: "Org A" }, { id: ORG_B, name: "Org B" }]);
    const ctx = contextFor([managerOf(ORG_A), managerOf(ORG_B)], async () => client);
    const out = await serveManifest(ctx, { requested: ORG_B, preferred: ORG_A });
    expect(out.ok && out.value).toMatchObject({ type: "manifest", gui: "gridtop", org: { id: ORG_B } });
    // Unset selects the default interface, as the layout reads it.
    vi.stubEnv("MGM_GUI", "");
    const unset = await serveManifest(ctx, {});
    expect(unset.ok && unset.value.gui).toBe("gridtop");
  });

  it("answers 500 for an MGM_GUI that names no interface, keeping the value out of the answer and the log", async () => {
    vi.stubEnv("MGM_GUI", "CANARY-gui-a41f");
    const newClient = vi.fn();
    const out = await serveManifest(contextFor([managerOf(ORG_A)], newClient), {});
    expect(out).toEqual({ ok: false, status: 500, code: "gui_manifest_failed", message: "The manifest could not be built." });
    expect(inspect(errors.mock.calls)).not.toContain("CANARY");
    expect(newClient).not.toHaveBeenCalled();
  });

  it("passes buildManifest's refusal on, and answers 500 when it throws", async () => {
    const { client } = tables([]);
    expect(await serveManifest(contextFor([managerOf(ORG_A)], async () => client), {})).toMatchObject({
      ok: false,
      status: 403,
      code: "gui_no_access",
    });
    const broken = tableClient({ organizations: { data: null, error: { message: "CANARY-db" } } }).client;
    const out = await serveManifest(contextFor([managerOf(ORG_A)], async () => broken), {});
    expect(out).toEqual({ ok: false, status: 500, code: "gui_manifest_failed", message: "The manifest could not be built." });
    expect(inspect(errors.mock.calls)).not.toContain("CANARY");
  });

  it("gives a tenant-only person the tenant manifest, with no organization", async () => {
    const UNIT = "e7100000-0000-4000-8004-0000000000a1";
    const { client } = tableClient({ user_profiles: { data: [] } }, tenantHomes([{ id: UNIT, name: "Nakato", orgId: ORG_A }]));
    const out = await serveManifest(contextFor([tenantOf(UNIT)], async () => client), {});
    expect(out.ok && out.value).toMatchObject({ org: { id: UNIT }, orgs: [] });
    expect(resolveTargetOrganization).not.toHaveBeenCalled();
  });

  it("refuses a context hostContext did not issue, before reading anything", async () => {
    await expect(serveManifest({ ...contextFor([managerOf(ORG_A)]) }, {})).rejects.toThrow(/did not issue/);
    expect(takeSnapshot).not.toHaveBeenCalled();
  });
});

describe("readManifestQuery", () => {
  const read = (search: string) => readManifestQuery(new URLSearchParams(search));

  it("reads a released page and an organization, the path's own ?org= when org is not given", () => {
    expect(read("")).toEqual({ ok: true, value: { path: null, requested: null } });
    expect(read(`path=/settings/users&org=${ORG_A.toUpperCase()}`)).toEqual({ ok: true, value: { path: "/settings/users", requested: ORG_A } });
    const path = `/?org=${ORG_B}`;
    expect(read(new URLSearchParams({ path }).toString())).toEqual({ ok: true, value: { path, requested: ORG_B } });
    expect(read(new URLSearchParams({ path, org: ORG_A }).toString())).toEqual({ ok: true, value: { path, requested: ORG_A } });
  });

  it.each([
    ["an unknown key", "orgs=x"],
    ["a ui.* key", "ui.tab=1"],
    ["an org that is not a UUID", "org=org-a"],
    ["two orgs", `org=${ORG_A}&org=${ORG_B}`],
    ["two paths", "path=/&path=/settings/users"],
    ["a protocol-relative path", "path=//evil.example/x"],
    ["an absolute URL", "path=https://evil.example/"],
    ["an API path", "path=/api/gui/view"],
    ["a page that is not released", "path=/not-a-page"],
  ])("refuses %s with 400", (_name, search) => {
    expect(read(search)).toMatchObject({ ok: false, status: 400, code: "gui_bad_request" });
  });
});
