/**
 * Every installed GUI draws each contributed view's examples, with Acme's
 * action merged in as the host would, and passes the conformance kit's view
 * checks on them: values and marks shown, controls reachable, writes only
 * through kit.act. A GUI's own tests cannot import a capability's examples
 * (gui-boundary.test.ts), so they are drawn here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { INSTALLED_GUIS } from "@/gui/installed";
import { BILLING_SURFACE } from "@/lib/billing/surface";
import { METERING_SURFACE } from "@/lib/metering/surface";
import { checkModel, loadLazyRenderers, withPoke } from "../conformance";
import type { ViewModel } from "../contract";

const EXAMPLES = [METERING_SURFACE, BILLING_SURFACE].flatMap((c) =>
  (c.views ?? []).flatMap((view) => view.examples.map((example, i) => ({ name: `${view.id} example ${i}`, model: example as ViewModel }))),
);

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
