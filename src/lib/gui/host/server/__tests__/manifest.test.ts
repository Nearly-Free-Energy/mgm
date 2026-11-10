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

import { STATUS_BUDGET_MS, buildManifest, getManifest, preloadManifest } from "../manifest";
import { ORG_A, ORG_B, contextFor, managerOf, superAdmin, tableClient } from "./host-fakes";

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
