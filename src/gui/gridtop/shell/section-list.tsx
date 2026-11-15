"use client";

/**
 * Loads each attached section with kit.loadView and draws it with Gridtop's
 * renderer for that view when it reads the model's ext version, else with
 * the kit's view. A refusal shows the host's message in place of the
 * section, and each section has its own boundary, so one that fails leaves
 * the page and the others as they are.
 *
 * A section loads again whenever the page's model is a new one, not only
 * when its href changes: the host hands a new model after kit.refresh() and
 * after an action succeeds, and a section can show figures that change with
 * them (savings after its settings are saved). The previous section stays
 * on screen until the new one arrives.
 *
 * The shell hands it the kit and the renderers, so it imports no module the
 * shell's first load holds (types aside): the bundler moves a module both
 * share into a chunk of its own, which costs the first load more than this
 * chunk saves it.
 */
import { Component, useEffect, useState, type ReactNode } from "react";
import type { ActionResult, GuiKit, GuiPlugin, SyncComponent, ViewModel, ViewProps } from "@/lib/gui/contract";

type Entry = ViewModel["attached"][number];
export type Renderers = NonNullable<GuiPlugin["renderers"]>;

/** Shows `fallback` once anything inside throws while rendering. */
class SectionBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const NOT_LOADED: ActionResult = { type: "result", ok: false, status: 0, code: "network", message: "This section could not be loaded." };
const NOTE = "gt:rounded-lg gt:border gt:border-border gt:bg-card gt:p-4 gt:text-body gt:text-muted-foreground";

/**
 * Gridtop's renderer for `model` when it reads the model's ext version; null
 * for the kit's view. The version test is the one pickRenderer
 * (src/lib/gui/host/shared/pick-renderer.ts) makes for a page, which a GUI
 * package may not import; if that rule changes, change this too.
 */
export function rendererFor(model: ViewModel, renderers: Renderers): { Component: SyncComponent<ViewProps> } | null {
  const renderer = Object.prototype.hasOwnProperty.call(renderers, model.view) ? renderers[model.view] : undefined;
  if (!renderer || !model.ext) return null;
  const at = model.ext.schema.lastIndexOf("@");
  const version = at < 0 ? NaN : Number(model.ext.schema.slice(at + 1));
  return Number.isInteger(version) && version >= 0 && renderer.reads.includes(version) ? renderer : null;
}

function Section({ entry, page, kit, renderers }: { entry: Entry; page: ViewModel; kit: GuiKit; renderers: Renderers }) {
  const [loaded, setLoaded] = useState<ViewModel | ActionResult | null>(null);
  useEffect(() => {
    let current = true;
    kit.loadView(entry.href).then(
      (out) => current && setLoaded(out),
      () => current && setLoaded(NOT_LOADED),
    );
    return () => {
      current = false;
    };
    // `page` is read only as a signal: a new page model loads the section again.
  }, [entry.href, page, kit]);

  if (loaded === null) {
    return <div role="status" aria-busy="true" aria-label={`Loading ${entry.title}`} className="gt:h-56 gt:animate-pulse gt:rounded-lg gt:bg-muted" />;
  }
  if (loaded.type !== "view") {
    return loaded.ok ? null : (
      <p role="alert" className={NOTE}>
        {loaded.message}
      </p>
    );
  }
  const renderer = rendererFor(loaded, renderers);
  return (
    <SectionBoundary fallback={<p className={NOTE}>{entry.title} could not be shown.</p>}>
      {renderer ? <renderer.Component model={loaded} /> : <kit.KitView model={loaded} />}
    </SectionBoundary>
  );
}

/** `page` is the page's model, whose sections these are; a new one loads every section again. */
export function SectionList({ sections, page, kit, renderers }: { sections: Entry[]; page: ViewModel; kit: GuiKit; renderers: Renderers }) {
  return (
    <div className="gt:mt-6 gt:flex gt:flex-col gt:gap-6">
      {sections.map((entry) => (
        <Section key={entry.href} entry={entry} page={page} kit={kit} renderers={renderers} />
      ))}
    </div>
  );
}
