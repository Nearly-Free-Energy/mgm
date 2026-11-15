/**
 * Metering's GUI contribution: the Operations day as `metering.site-day`,
 * which serves the Operations page and its nav entry, accepted by the
 * registry and removed with it, with examples a GUI can be tested against.
 */
import { describe, expect, it } from "vitest";
import { SYNTHETIC_NOTICE } from "@/lib/gui/host/server/view";
import { strictParseModel } from "@/lib/gui/host/server/parse";
import { SurfaceRegistry } from "@/lib/gui/host/server/surface-registry";
import type { ViewDef } from "@/lib/gui/surface";
import { MGM_BUNDLED_PLUGINS, matchCatalogPage } from "@/lib/plugins/bundled";
import { METERING_SURFACE } from "../surface";
import { SITE_DAY_LOADED_EXAMPLES } from "../surface/examples";
import { loadSiteDay } from "../surface/site-day";
import { SITE_DAY_KEYS } from "../surface/site-day-model";

const view = METERING_SURFACE.views?.[0] as ViewDef;
type Tile = { key: string; value: { t: string; text: string; synthetic?: true } };
const tiles = (i: number) => (SITE_DAY_LOADED_EXAMPLES[i].body.tiles as Tile[]);
const tile = (i: number, key: string) => tiles(i).find((t) => t.key === key);

describe("METERING_SURFACE", () => {
  it("contributes the Operations day as a vendor view of a microgrid that reads ?date=", () => {
    expect(METERING_SURFACE.views?.map((v) => v.id)).toEqual(["metering.site-day"]);
    expect(view).toMatchObject({
      kind: "metrics",
      path: "/microgrids/[id]/operations",
      params: { id: "microgrid" },
      entity: "id",
      query: ["date"],
      attach: { to: "microgrid", order: 10, hint: "tab" },
      cost: "vendor",
      declares: { keys: SITE_DAY_KEYS },
      ext: { schema: "metering.site-day@1" },
      load: loadSiteDay,
    });
    // Not polled, and not readable by an assistant.
    expect(view).not.toHaveProperty("live");
    expect(view).not.toHaveProperty("agent");
  });

  it("serves the Operations page through the view: a nav entry naming it, and a catalog page served by a view", () => {
    const entry = METERING_SURFACE.nav?.find((n) => n.id === "metering.operations");
    expect(entry).toMatchObject({ view: "metering.site-day", group: "operate", order: 40 });
    expect(entry).not.toHaveProperty("href");
    expect(entry).not.toHaveProperty("legacy");
    expect(matchCatalogPage(`/microgrids/${"0".repeat(8)}/operations`)?.page).toMatchObject({
      path: view.path,
      servedBy: "view",
    });
  });

  it("is accepted by the registry, and removed when its plugin unloads", () => {
    const registry = new SurfaceRegistry({ plugins: MGM_BUNDLED_PLUGINS });
    const remove = registry.contribute(METERING_SURFACE);
    expect(registry.snapshot().views.map((v) => [v.plugin, v.def.id])).toEqual([["metering", "metering.site-day"]]);
    remove();
    expect(registry.snapshot().views).toEqual([]);
    expect(registry.snapshot().nav).toEqual([]);
  });
});

describe("the site-day examples", () => {
  it("pass the view's strict parse as its loader would return them", () => {
    for (const model of SITE_DAY_LOADED_EXAMPLES) expect(strictParseModel(view, model)).toMatchObject({ ok: true });
  });

  it("are a normal day, a day with cuts and dark time, a site with no battery, and no site devices", () => {
    expect(tile(0, "cuts")?.value.text).toBe("0");
    expect(tile(0, "lights-on")).not.toHaveProperty("status");
    expect(Number(tile(1, "cuts")?.value.text)).toBeGreaterThan(0);
    expect(tile(1, "lights-on")).toHaveProperty("status");
    expect(SITE_DAY_LOADED_EXAMPLES[2].body.series).toBeUndefined();
    expect(tile(2, "lowest-soc")).toMatchObject({ value: { t: "empty" }, hint: "Needs a battery" });
    expect(tiles(3).map((t) => t.key)).toEqual(["setup"]);
    expect(SITE_DAY_LOADED_EXAMPLES[3].links?.[0].id).toBe("metering.edges");
    // Each generated day links to the page that holds the microgrid's Edit, as the loader's day does.
    for (const i of [0, 1, 2]) expect(SITE_DAY_LOADED_EXAMPLES[i].links?.at(-1)?.id).toBe("metering.microgrid-setup");
  });

  it("mark generated days synthetic, with the notice the host adds", () => {
    view.examples.forEach((example, i) => {
      const generated = i < 3;
      expect(tiles(i).every((t) => t.value.synthetic === true)).toBe(generated);
      expect(example.notice).toEqual(generated ? SYNTHETIC_NOTICE : undefined);
      expect(example).toMatchObject({ type: "view", view: "metering.site-day", kind: "metrics", actions: [], attached: [] });
    });
  });
});
