/**
 * loadLazyRenderers: a GUI that loads a bespoke renderer as a chunk of its
 * own (React.lazy) is checked on what that renderer draws, not on the empty
 * render while the chunk is pending, and a renderer that draws nothing is
 * still reported.
 */
import { lazy, Suspense, type ComponentType } from "react";
import { describe, expect, it } from "vitest";
import type { GuiPlugin, ViewModel, ViewProps } from "../../contract";
import { kit } from "../../kit";
import { checkModel, loadLazyRenderers, MODEL_FIXTURES, withPoke } from "..";
import { referenceGui } from "./reference-gui";

/** Longer than a render takes to settle, so a check that does not wait sees the chunk pending. */
const CHUNK_MS = 500;

const fixture = (name: string): ViewModel => {
  const found = MODEL_FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no model fixture "${name}"`);
  return withPoke({ ...found.model, ext: { schema: `${found.model.view}@1`, data: {} as never } });
};
const METRICS = fixture("metrics with a notice");
const RECORD = fixture("record of every value");

const Draws = ({ model }: ViewProps) => <kit.KitView model={model} />;
const DrawsNothing = () => null;

/** A renderer loaded after CHUNK_MS, behind a Suspense whose fallback shows nothing. */
function later(Inner: ComponentType<ViewProps>) {
  const Chunk = lazy(() => new Promise<{ default: ComponentType<ViewProps> }>((resolve) => setTimeout(() => resolve({ default: Inner }), CHUNK_MS)));
  return function Lazy({ model }: ViewProps) {
    return (
      <Suspense fallback={null}>
        <Chunk model={model} />
      </Suspense>
    );
  };
}

/** The reference GUI with a lazy renderer, each its own chunk, for both models' views. A new GUI has nothing loaded yet. */
function lazyGui(Inner: ComponentType<ViewProps> = Draws): GuiPlugin {
  return {
    ...referenceGui(),
    renderers: {
      [METRICS.view]: { reads: [1], Component: later(Inner) },
      [RECORD.view]: { reads: [1], Component: later(Inner) },
    },
  };
}

const missing = (findings: { message: string }[]) => findings.filter((f) => f.message.startsWith("does not show"));

describe("loadLazyRenderers", () => {
  it("is needed: without it, a renderer still loading is reported as showing nothing", async () => {
    expect(missing(await checkModel(lazyGui(), METRICS, "metrics"))).not.toEqual([]);
  }, 30_000);

  it("loads every view's renderer, so the checks see what each draws", async () => {
    const gui = lazyGui();
    await loadLazyRenderers(gui, [METRICS, RECORD]);
    expect(await checkModel(gui, METRICS, "metrics")).toEqual([]);
    expect(await checkModel(gui, RECORD, "record")).toEqual([]);
  }, 30_000);

  it("does not hide a renderer that draws nothing", async () => {
    const gui = lazyGui(DrawsNothing);
    await loadLazyRenderers(gui, [METRICS], 2 * CHUNK_MS);
    expect(missing(await checkModel(gui, METRICS, "metrics"))).not.toEqual([]);
  }, 30_000);
});
