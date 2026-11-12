/**
 * /go/<nav>: where a navigation entry's id leads for the person's manifest,
 * and that resolveGoTarget reads the manifest with the layout's hints.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BILLING_SURFACE } from "@/lib/billing/surface";
import { COMMUNITY_MANAGEMENT_SURFACE } from "@/lib/community-management/surface";
import { METERING_SURFACE } from "@/lib/metering/surface";
import { ORGANIZATION_DIRECTORY_SURFACE } from "@/lib/organization-directory/surface";
import { PAYMENTS_SURFACE } from "@/lib/payments/surface";
import { MGM_BUNDLED_PLUGINS, type MgmPluginName } from "@/lib/plugins/bundled";
import type { Manifest, NavEntry } from "../../../contract";
import { buildManifestModel, type ManifestInput } from "../../shared/manifest-model";

const mocks = vi.hoisted(() => ({
  getManifest: vi.fn(),
  headers: new Headers(),
  cookies: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({
    get: (name: string) => (mocks.cookies.has(name) ? { name, value: mocks.cookies.get(name) } : undefined),
  }),
}));
vi.mock("../manifest", () => ({ getManifest: mocks.getManifest }));
// Pages that need a community and a microgrid, in either order, which no released page does yet.
const PAIR_ROUTES = [/^\/communities\/[^/]+\/microgrids\/[^/]+$/, /^\/microgrids\/[^/]+\/communities\/[^/]+$/];
vi.mock("@/lib/mgm/released-routes", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/mgm/released-routes")>();
  return { isReleasedRoute: (path: string) => PAIR_ROUTES.some((r) => r.test(path)) || actual.isReleasedRoute(path) };
});

import { goTarget, resolveGoTarget } from "../go";

const ORG = "e7300000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7300000-0000-4000-8000-000000000002";
const C1 = "e7300000-0000-4000-8001-000000000001";
const C2 = "e7300000-0000-4000-8001-000000000002";
const M1 = "e7300000-0000-4000-8002-000000000001";
const M2 = "e7300000-0000-4000-8002-000000000002";
const M3 = "e7300000-0000-4000-8002-000000000003";

const SURFACES = [
  ORGANIZATION_DIRECTORY_SURFACE,
  COMMUNITY_MANAGEMENT_SURFACE,
  METERING_SURFACE,
  BILLING_SURFACE,
  PAYMENTS_SURFACE,
];

const ALL_ON = Object.fromEntries(MGM_BUNDLED_PLUGINS.map((p) => [p.name, true])) as Record<MgmPluginName, boolean>;

function manifest(o: Partial<Pick<ManifestInput, "communities" | "microgrids" | "gate" | "superAdmin">> = {}): Manifest {
  return buildManifestModel({
    release: null,
    locale: "en",
    now: new Date(0),
    gui: "gridtop",
    user: { name: null, email: "manager@example.test" },
    superAdmin: o.superAdmin ?? false,
    org: { id: ORG, name: "Org One" },
    orgs: [{ id: ORG, name: "Org One" }],
    gate: o.gate ?? ALL_ON,
    nav: SURFACES.flatMap((s) => (s.nav ?? []).map((def) => ({ plugin: s.plugin, def }))) as ManifestInput["nav"],
    views: [],
    status: [],
    communities: o.communities ?? [{ id: C1, name: "Kasana" }],
    microgrids: o.microgrids ?? [{ id: M1, name: "Kasana East", communityId: C1, timezone: null }],
  });
}

/** `m` with one more nav entry, for patterns no plugin contributes today. */
function withEntry(m: Manifest, entry: Partial<NavEntry> & Pick<NavEntry, "href" | "needs">): Manifest {
  const added: NavEntry = { id: "test.entry", title: "Test entry", icon: "today", group: "operate", order: 99, ...entry };
  return { ...m, org: { ...m.org, nav: [...m.org.nav, added] } };
}

describe("goTarget", () => {
  it("answers not found for an id no entry has", () => {
    expect(goTarget(manifest(), "billing.nothing")).toEqual({ kind: "not-found" });
    expect(goTarget(manifest(), "")).toEqual({ kind: "not-found" });
  });

  it("answers not found for an entry the manifest leaves out for this person", () => {
    expect(goTarget(manifest(), "org.organizations")).toEqual({ kind: "not-found" });
    expect(goTarget(manifest({ superAdmin: true }), "org.organizations")).toEqual({
      kind: "redirect",
      href: "/organizations",
    });
  });

  it("answers not found for an entry of a plugin that is off", () => {
    expect(goTarget(manifest({ gate: { ...ALL_ON, billing: false } }), "billing.periods")).toEqual({ kind: "not-found" });
  });

  it("sends an entry that needs no place to its page", () => {
    expect(goTarget(manifest(), "org.plugins")).toEqual({ kind: "redirect", href: "/settings/plugins" });
    expect(goTarget(manifest(), "org.today")).toEqual({ kind: "redirect", href: "/" });
  });

  it("keeps the organization ?org= chose for an entry with no organization in its path", () => {
    expect(goTarget(manifest(), "org.plugins", ORG)).toEqual({
      kind: "redirect",
      href: `/settings/plugins?org=${ORG}`,
    });
    expect(goTarget(manifest(), "org.today", ORG)).toEqual({ kind: "redirect", href: `/?org=${ORG}` });
    // ?org= named an organization the manifest did not pick: nothing to keep.
    expect(goTarget(manifest(), "org.plugins", OTHER_ORG)).toEqual({ kind: "redirect", href: "/settings/plugins" });
    // The path names the organization or a place in it already.
    expect(goTarget(manifest(), "payments.org-accounts", ORG)).toEqual({
      kind: "redirect",
      href: `/organizations/${ORG}/payments`,
    });
    expect(goTarget(manifest(), "billing.periods", ORG)).toEqual({ kind: "redirect", href: `/microgrids/${M1}/billing` });
  });

  it("fills an entry that needs only the organization with the manifest's organization", () => {
    expect(goTarget(manifest(), "payments.org-accounts")).toEqual({
      kind: "redirect",
      href: `/organizations/${ORG}/payments`,
    });
  });

  it("sends an entry that needs a microgrid to the only one", () => {
    expect(goTarget(manifest(), "billing.periods")).toEqual({ kind: "redirect", href: `/microgrids/${M1}/billing` });
    expect(goTarget(manifest(), "metering.operations")).toEqual({
      kind: "redirect",
      href: `/microgrids/${M1}/operations`,
    });
  });

  it("lists the microgrids when there are several", () => {
    const m = manifest({
      microgrids: [
        { id: M1, name: "Kasana East", communityId: C1, timezone: null },
        { id: M2, name: "Kasana West", communityId: C1, timezone: null },
      ],
    });
    expect(goTarget(m, "billing.periods")).toEqual({
      kind: "choose",
      title: "Billing",
      needs: ["microgrid"],
      choices: [
        { label: "Kasana East", href: `/microgrids/${M1}/billing` },
        { label: "Kasana West", href: `/microgrids/${M2}/billing` },
      ],
    });
  });

  it("says so when there is no microgrid, with the page that lists them", () => {
    expect(goTarget(manifest({ communities: [], microgrids: [] }), "billing.periods")).toEqual({
      kind: "none",
      title: "Billing",
      needs: ["microgrid"],
      missing: "microgrid",
      listed: true,
      list: { label: "Microgrids", href: "/microgrids" },
    });
  });

  it("says so for a kind the manifest never lists as a place, with no list", () => {
    const m = withEntry(manifest(), { href: "/microgrids/[microgrid]/setup/edges/[edge]", needs: ["microgrid", "edge"] });
    expect(goTarget(m, "test.entry")).toMatchObject({ kind: "none", missing: "edge", listed: false, list: null });
  });

  describe("an entry that needs a community and a microgrid", () => {
    const places = {
      communities: [
        { id: C1, name: "Kasana" },
        { id: C2, name: "Luweero" },
      ],
      microgrids: [
        { id: M1, name: "Kasana East", communityId: C1, timezone: null },
        { id: M3, name: "Luweero North", communityId: C2, timezone: null },
      ],
    };
    const pair = { href: "/communities/[community]/microgrids/[microgrid]" as const, needs: ["community", "microgrid"] as NavEntry["needs"] };

    it("pairs each microgrid only with its own community", () => {
      expect(goTarget(withEntry(manifest(places), pair), "test.entry")).toEqual({
        kind: "choose",
        title: "Test entry",
        needs: ["community", "microgrid"],
        choices: [
          { label: "Kasana › Kasana East", href: `/communities/${C1}/microgrids/${M1}` },
          { label: "Luweero › Luweero North", href: `/communities/${C2}/microgrids/${M3}` },
        ],
      });
    });

    it("does not take a lone microgrid of another community, and does not ask for one to be added", () => {
      const m = manifest({ communities: [{ id: C2, name: "Luweero" }], microgrids: [places.microgrids[0]] });
      expect(goTarget(withEntry(m, pair), "test.entry")).toMatchObject({
        kind: "none",
        missing: null,
        listed: false,
        list: null,
      });
    });

    it("asks for the first kind there is none of", () => {
      expect(goTarget(withEntry(manifest({ communities: [], microgrids: [] }), pair), "test.entry")).toMatchObject({
        kind: "none",
        missing: "community",
        listed: true,
        list: { href: "/communities" },
      });
    });

    describe("with the microgrid first in the path", () => {
      const reversed = {
        href: "/microgrids/[microgrid]/communities/[community]" as const,
        needs: ["microgrid", "community"] as NavEntry["needs"],
      };

      it("pairs each microgrid only with its own community", () => {
        expect(goTarget(withEntry(manifest(places), reversed), "test.entry")).toMatchObject({
          kind: "choose",
          choices: [
            { label: "Kasana East › Kasana", href: `/microgrids/${M1}/communities/${C1}` },
            { label: "Luweero North › Luweero", href: `/microgrids/${M3}/communities/${C2}` },
          ],
        });
      });

      it("does not take a lone community of another microgrid", () => {
        const m = manifest({ communities: [{ id: C1, name: "Kasana" }], microgrids: [places.microgrids[1]] });
        expect(goTarget(withEntry(m, reversed), "test.entry")).toMatchObject({ kind: "none", missing: null });
      });
    });

    it("sends the person on when exactly one pair belongs together", () => {
      const m = manifest({ ...places, microgrids: [places.microgrids[0]] });
      expect(goTarget(withEntry(m, pair), "test.entry")).toEqual({
        kind: "redirect",
        href: `/communities/${C1}/microgrids/${M1}`,
      });
    });
  });

  it("encodes a place's id into the path", () => {
    const m = manifest({ microgrids: [{ id: "mg 1", name: "Odd", communityId: C1, timezone: null }] });
    expect(goTarget(m, "billing.periods")).toEqual({ kind: "redirect", href: "/microgrids/mg%201/billing" });
  });

  it("never sends the person off the site, whatever a place's id holds", () => {
    for (const id of ["//evil.example", "../../login", "https://evil.example", "a/b", "\\\\evil.example"]) {
      const m = manifest({ microgrids: [{ id, name: "Odd", communityId: C1, timezone: null }] });
      const target = goTarget(m, "billing.periods");
      if (target.kind === "redirect") {
        expect(target.href, id).toMatch(/^\/microgrids\/[^/]+\/billing$/);
      } else {
        expect(target, id).toMatchObject({ kind: "none" });
      }
    }
  });

  it("sends the person only to a released page", () => {
    const m = withEntry(manifest(), { href: "/microgrids/[microgrid]/unreleased", needs: ["microgrid"] });
    expect(goTarget(m, "test.entry")).toMatchObject({ kind: "none" });
    const plain = withEntry(manifest(), { href: "/unreleased", needs: [] });
    expect(goTarget(plain, "test.entry")).toEqual({ kind: "not-found" });
  });
});

describe("resolveGoTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.headers = new Headers();
    mocks.cookies.clear();
    mocks.getManifest.mockResolvedValue({ ok: true, manifest: manifest() });
  });

  it("reads the manifest with the layout's hints, so the two share one read", async () => {
    mocks.headers = new Headers({ "x-mgm-path": `/go/billing.periods?org=${OTHER_ORG}` });
    mocks.cookies.set("mgm-org", ORG);
    await expect(resolveGoTarget("billing.periods")).resolves.toEqual({
      kind: "redirect",
      href: `/microgrids/${M1}/billing`,
    });
    expect(mocks.getManifest).toHaveBeenCalledWith("gridtop", `/go/billing.periods?org=${OTHER_ORG}`, OTHER_ORG, ORG);
  });

  it("passes the path's ?org= on, so the page opens in the organization it chose", async () => {
    mocks.headers = new Headers({ "x-mgm-path": `/go/org.plugins?org=${ORG}` });
    await expect(resolveGoTarget("org.plugins")).resolves.toEqual({
      kind: "redirect",
      href: `/settings/plugins?org=${ORG}`,
    });
  });

  it("sends a person whose session the manifest refuses to /login", async () => {
    mocks.getManifest.mockResolvedValue({ ok: false, status: 401, code: "unauthorized", message: "Sign in." });
    await expect(resolveGoTarget("billing.periods")).resolves.toEqual({ kind: "redirect", href: "/login" });
  });

  it("sends a person who can see no organization to /no-access", async () => {
    mocks.getManifest.mockResolvedValue({ ok: false, status: 403, code: "gui_no_access", message: "None." });
    await expect(resolveGoTarget("billing.periods")).resolves.toEqual({ kind: "redirect", href: "/no-access" });
  });

  it("fails when MGM_GUI names no compiled-in GUI, as the layout does", async () => {
    vi.stubEnv("MGM_GUI", "nonesuch");
    await expect(resolveGoTarget("billing.periods")).rejects.toThrow(/MGM_GUI/);
    expect(mocks.getManifest).not.toHaveBeenCalled();
  });
});
