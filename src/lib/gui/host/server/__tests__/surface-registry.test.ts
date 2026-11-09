import { describe, expect, it } from "vitest";
import {
  MGM_BUNDLED_PLUGINS,
  ORGANIZATION_DIRECTORY_PLUGIN,
  type BundledPlugin,
  type MgmPluginName,
} from "@/lib/plugins/bundled";
import type { GuiMeta } from "../../../contract";
import type { Contribution } from "../../../surface";
import { BILLING_SURFACE } from "../../../__tests__/fixtures/billing-surface";
import { SurfaceContributionError, type SurfaceCatalog } from "../contribution-schema";
import { SurfaceRegistry } from "../surface-registry";

/** Aliases are unique in the real catalog, so a clash across plugins needs a forged one. */
const FORGED = {
  ...MGM_BUNDLED_PLUGINS[0],
  name: "forged" as MgmPluginName,
  alias: "billing",
  core: false,
  routes: ["/forged", "/api/forged"],
} satisfies BundledPlugin;
/** A second contributor with an alias of its own. */
const OTHER = { ...FORGED, name: "other" as MgmPluginName, alias: "other", routes: ["/other", "/api/other"] };
/** The real catalog, with the fixture's page routes and two probe routes given to billing. */
const CATALOG: SurfaceCatalog = {
  plugins: [
    ...MGM_BUNDLED_PLUGINS.map((p) =>
      p.name === "billing"
        ? {
            ...p,
            routes: [
              ...p.routes,
              "/microgrids/[id]/billing",
              "/microgrids/[id]/setup/rates",
              "/billing-probe",
              "/api/billing-probe",
            ],
          }
        : p,
    ),
    FORGED,
    OTHER,
  ],
};

const ORGANIZATION_OF = async () => null;

/** One entry in every list, with ids under `alias` and routes under `root`. */
function surfaceOf(plugin: string, alias: string, root: string): Contribution {
  const view = BILLING_SURFACE.views![0];
  const id = `${alias}.view`;
  return {
    plugin,
    nav: [{ id: `${alias}.nav`, href: root, needs: [], legacy: true, title: "Probe", icon: "billing", group: "money", order: 1 }],
    views: [
      {
        id,
        kind: "collection",
        path: `${root}/[id]`,
        params: { id: "microgrid" },
        cost: "db",
        declares: view.declares,
        examples: [{ ...(view.examples[0] as object), view: id }],
        load: view.load,
      },
    ],
    actions: [{ ...BILLING_SURFACE.actions![0], id: `${alias}.act`, path: `/api${root}` }],
    signals: [{ id: `${alias}.signal`, load: async () => [] }],
    status: [{ id: `${alias}.status`, load: async () => [] }],
    search: [{ prefix: "@", entity: "microgrid", find: async () => [] }],
    entities: [{ kind: `${alias}.thing`, organizationOf: ORGANIZATION_OF }],
  } as unknown as Contribution;
}

const signal = (plugin: string, id: string) =>
  ({ plugin, signals: [{ id, load: async () => [] }] }) as unknown as Contribution;

const META: GuiMeta = {
  name: "probe",
  title: "Probe",
  version: "0.1.0",
  contract: "^0.1",
  styles: "./styles.css",
  dependencies: [],
};

function empty(registry: SurfaceRegistry) {
  const s = registry.snapshot();
  return [s.views, s.nav, s.signals, s.status, s.search, s.guis].every((l) => l.length === 0)
    && s.actions.size === 0 && s.entities.size === 0;
}

describe("SurfaceRegistry.contribute", () => {
  it("registers a contribution with its plugin, and its disposer leaves nothing behind", () => {
    const registry = new SurfaceRegistry(CATALOG);
    const dispose = registry.contribute(BILLING_SURFACE);
    const s = registry.snapshot();
    expect(s.views.map((v) => [v.plugin, v.def.id])).toEqual([
      ["billing", "billing.periods"],
      ["billing", "billing.period-review"],
      ["billing", "billing.close-checklist"],
    ]);
    expect([...s.actions.keys()]).toEqual(["billing.create-period", "billing.generate-bills", "billing.close-period"]);
    expect(s.actions.get("billing.close-period")?.plugin).toBe("billing");
    expect(s.nav.map((n) => n.def.id)).toEqual(["billing.nav", "billing.tariff"]);
    expect(s.signals.map((x) => [x.plugin, x.id])).toEqual([["billing", "billing.period-due"]]);
    expect(registry.snapshot()).toBe(s);
    expect(Object.isFrozen(s)).toBe(true);

    dispose();
    expect(empty(registry)).toBe(true);
    // The ids are free again.
    registry.contribute(BILLING_SURFACE);
    expect(registry.snapshot().views).toHaveLength(3);
  });

  it("refuses a second contribution from the same plugin", () => {
    const registry = new SurfaceRegistry(CATALOG);
    registry.contribute(signal("billing", "billing.one"));
    expect(() => registry.contribute(signal("billing", "billing.two"))).toThrow(
      'GUI contribution from "billing" refused:\n✖ billing has already contributed\n  → at plugin',
    );
    expect(registry.snapshot().signals.map((x) => x.id)).toEqual(["billing.one"]);
  });

  it.each([
    ["nav", "id"],
    ["views", "id"],
    ["actions", "id"],
    ["signals", "id"],
    ["status", "id"],
    ["entities", "kind"],
  ] as const)("refuses a %s entry whose id another plugin registered", (list, field) => {
    const only = (c: Contribution) => ({ plugin: c.plugin, [list]: c[list] }) as Contribution;
    const registry = new SurfaceRegistry(CATALOG);
    const billing = only(surfaceOf("billing", "billing", "/billing-probe"));
    registry.contribute(billing);
    let error: unknown;
    try {
      registry.contribute(only(surfaceOf("forged", "billing", "/forged")));
    } catch (e) {
      error = e;
    }
    const id = (billing[list] as unknown as Record<string, string>[])[0][field];
    expect(error).toBeInstanceOf(SurfaceContributionError);
    expect((error as SurfaceContributionError).message).toBe(
      `GUI contribution from "forged" refused:\n✖ "${id}" is already registered by billing\n  → at ${list}[0].${field}`,
    );
    const s = registry.snapshot();
    expect([...s.views, ...s.nav, ...s.signals, ...s.status, ...s.actions.values(), ...s.entities.values()].map((x) => x.plugin))
      .toEqual(["billing"]);
  });

  it("names the contributing plugin on every list, and each disposer removes only its own", () => {
    const registry = new SurfaceRegistry(CATALOG);
    const billing = surfaceOf("billing", "billing", "/billing-probe");
    const disposeBilling = registry.contribute(billing);
    const disposeOther = registry.contribute(surfaceOf("other", "other", "/other"));
    const s = registry.snapshot();
    const both = (name: string) => [["billing", `billing.${name}`], ["other", `other.${name}`]];
    expect(s.views.map((v) => [v.plugin, v.def.id])).toEqual(both("view"));
    expect([...s.actions].map(([id, a]) => [a.plugin, id])).toEqual(both("act"));
    expect(s.nav.map((n) => [n.plugin, n.def.id])).toEqual(both("nav"));
    expect(s.signals.map((x) => [x.plugin, x.id])).toEqual(both("signal"));
    expect(s.status.map((x) => [x.plugin, x.id])).toEqual(both("status"));
    expect(s.search.map((x) => [x.plugin, x.entity])).toEqual([["billing", "microgrid"], ["other", "microgrid"]]);
    expect([...s.entities].map(([kind, e]) => [e.plugin, kind])).toEqual(both("thing"));
    expect(s.entities.get("billing.thing")?.organizationOf).toBe(ORGANIZATION_OF);
    expect(s.signals[0].load).toBe(billing.signals![0].load);

    disposeBilling();
    const left = registry.snapshot();
    expect(
      [...left.views, ...left.nav, ...left.signals, ...left.status, ...left.search, ...left.actions.values(), ...left.entities.values()]
        .map((x) => x.plugin),
    ).toEqual(Array(7).fill("other"));
    disposeOther();
    expect(empty(registry)).toBe(true);
  });

  it("keeps a frozen copy of what it checked, not the contributor's objects", () => {
    const registry = new SurfaceRegistry(CATALOG);
    const c = surfaceOf("billing", "billing", "/billing-probe");
    registry.contribute(c);
    (c.signals as unknown[]).push({ id: "NOT VALID", load: async () => [], extra: 1 });
    (c.actions![0] as { risk: string }).risk = "destructive";
    (c.views![0].params as Record<string, string>).id = "household";
    const s = registry.snapshot();
    expect(s.signals.map((x) => x.id)).toEqual(["billing.signal"]);
    expect(s.actions.get("billing.act")?.def.risk).toBe("money");
    expect(s.views[0].def.params).toEqual({ id: "microgrid" });
    expect(Object.isFrozen(s.views[0].def.params)).toBe(true);
  });

  it("refuses what the contribution parse refuses, naming the plugin and the path", () => {
    const registry = new SurfaceRegistry(CATALOG);
    const unprepared: Record<string, unknown> = { ...BILLING_SURFACE.actions?.[2] };
    delete unprepared.prepare;
    expect(() => registry.contribute({ plugin: "billing", actions: [unprepared] } as Contribution)).toThrow(
      /"billing"[\s\S]*actions\[0\]\.prepare/,
    );
    expect(empty(registry)).toBe(true);
  });

  it("ignores a disposer once its contribution is gone", () => {
    const registry = new SurfaceRegistry(CATALOG);
    const first = registry.contribute(signal("billing", "billing.due"));
    first();
    registry.contribute(signal("billing", "billing.due"));
    first();
    expect(registry.snapshot().signals).toHaveLength(1);
  });
});

describe("SurfaceRegistry.install", () => {
  it("installs a GUI whose range includes the contract, and its disposer removes it", () => {
    const registry = new SurfaceRegistry(CATALOG);
    expect(registry.snapshot().guis).toEqual([]);
    const dispose = registry.install(META);
    expect(registry.gui("probe")).toEqual(META);
    // It keeps the parsed copy, frozen.
    expect(registry.gui("probe")).not.toBe(META);
    expect(Object.isFrozen(registry.gui("probe"))).toBe(true);
    expect(registry.snapshot().guis.map((g) => g.name)).toEqual(["probe"]);
    dispose();
    expect(registry.gui("probe")).toBeUndefined();
    expect(empty(registry)).toBe(true);
  });

  it("refuses a range that excludes the contract, naming the GUI and both versions", () => {
    const registry = new SurfaceRegistry(CATALOG);
    expect(() => registry.install({ ...META, contract: "^0.2" })).toThrow(
      'GUI "probe" supports GUI contract ^0.2; this MGM provides 0.1.0',
    );
    expect(registry.gui("probe")).toBeUndefined();
  });

  it("ignores a disposer once its GUI is gone", () => {
    const registry = new SurfaceRegistry(CATALOG);
    const first = registry.install(META);
    first();
    registry.install(META);
    first();
    expect(registry.gui("probe")).toBeDefined();
  });

  it("refuses a catalog plugin's name and a name already installed", () => {
    const registry = new SurfaceRegistry(CATALOG);
    expect(() => registry.install({ ...META, name: "billing" })).toThrow(
      'GUI "billing" has the name of a plugin in the catalog',
    );
    // Names are compared, not aliases.
    const org = ORGANIZATION_DIRECTORY_PLUGIN;
    expect(org.alias).not.toBe(org.name);
    expect(() => registry.install({ ...META, name: org.name })).toThrow(
      `GUI "${org.name}" has the name of a plugin in the catalog`,
    );
    registry.install({ ...META, name: org.alias })();
    registry.install(META);
    expect(() => registry.install({ ...META, title: "Again" })).toThrow('GUI "probe" is already installed');
    expect(registry.gui("probe")?.title).toBe("Probe");
  });

  it("refuses malformed metadata", () => {
    const registry = new SurfaceRegistry(CATALOG);
    expect(() => registry.install({ ...META, extra: true } as GuiMeta)).toThrow(/GUI "probe" metadata refused/);
    expect(() => registry.install({ ...META, contract: ">=0.1" })).toThrow(/GUI "probe" metadata refused/);
  });
});
