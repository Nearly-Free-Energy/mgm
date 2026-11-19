/**
 * Every installed GUI draws each contributed view's examples, with Acme's
 * action merged in as the host would, and passes the conformance kit's view
 * checks on them: values and marks shown, controls reachable, writes only
 * through kit.act. A GUI's own tests cannot import a capability's examples
 * (gui-boundary.test.ts), so they are drawn here.
 *
 * The views come from the real runtime root's surface snapshot, the one the
 * host serves pages from, so a capability's new view joins this matrix when
 * its contribution plugin joins PLATFORM_PLUGINS (src/lib/runtime/root.ts),
 * with no list here to update. gui-surface.test.ts boots the same root.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTALLED_GUIS } from "@/gui/installed";
import { getMgmRuntime, resetMgmRuntimeForTests } from "@/lib/runtime/root";
import { checkModel, loadLazyRenderers, renderModel, withPoke } from "../conformance";
import type { ViewModel } from "../contract";

const { views } = (await getMgmRuntime()).mgmSurface.snapshot();

const EXAMPLES = views.flatMap(({ def: view }) =>
  view.examples.map((example, i) => ({ name: `${view.id} example ${i}`, model: example as ViewModel })),
);

afterAll(() => resetMgmRuntimeForTests());

it("draws at least one view from the runtime's contributions", () => {
  // An empty snapshot would turn every row below into a vacuous pass.
  expect(views.length).toBeGreaterThan(0);
  for (const { def } of views) expect(def.examples.length, def.id).toBeGreaterThan(0);
});

// A GUI may load a bespoke renderer as a chunk of its own (React.lazy), and
// checkModel does not wait for a pending chunk, so load them first.
beforeAll(async () => {
  for (const gui of Object.values(INSTALLED_GUIS)) await loadLazyRenderers(gui, EXAMPLES.map((e) => withPoke(e.model)));
}, 120_000);

describe.each(Object.entries(INSTALLED_GUIS))("%s draws the contributed views' examples", (_name, gui) => {
  it.each(EXAMPLES.map((e) => [e.name, e.model] as const))("%s", async (name, model) => {
    const poked = withPoke(model);
    expect(poked.actions.length, "acme.poke is merged onto the example's entity").toBeGreaterThan(0);
    expect(await checkModel(gui, poked, name)).toEqual([]);
  });
});

/**
 * A bespoke renderer that cannot read an example's ext draws the kit's view
 * instead, which passes every check above, so a renderer and its view's ext
 * could drift apart with this file green. A renderer that marks its own
 * drawing is listed here with the mark, and must have drawn every example of
 * its view whose ext version it reads. Each mark is the renderer's own
 * (src/gui/<name>/renderers/); if one changes, change it here.
 */
const RENDERER_MARKS: Partial<Record<keyof typeof INSTALLED_GUIS, Record<string, string>>> = {
  gridtop: { "billing.period-review": "[data-period-review]" },
};

describe.each(Object.entries(RENDERER_MARKS))("%s draws its marked renderers' examples itself", (name, marks) => {
  const gui = INSTALLED_GUIS[name as keyof typeof INSTALLED_GUIS];
  it.each(Object.entries(marks))("%s", async (view, mark) => {
    const read = gui.renderers?.[view as `${string}.${string}`]?.reads ?? [];
    const drawn = EXAMPLES.filter(({ model }) => {
      const schema = model.view === view ? model.ext?.schema : undefined;
      return schema !== undefined && read.includes(Number(schema.slice(schema.lastIndexOf("@") + 1)));
    });
    expect(drawn.length, `${view} has examples its renderer reads`).toBeGreaterThan(0);
    for (const { name: example, model } of drawn) {
      const { unmount } = await renderModel(gui, withPoke(model));
      try {
        expect(document.querySelector(mark), `${example} is drawn by ${name}'s renderer, not the kit's view`).not.toBeNull();
      } finally {
        unmount();
      }
    }
  });
});
