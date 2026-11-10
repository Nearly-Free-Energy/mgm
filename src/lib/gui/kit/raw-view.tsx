"use client";

/**
 * The fallback for a view the interface cannot draw: a kind that arrived in a
 * later contract version, or one it does not know. It shows what every kind
 * shares and says the body needs a newer interface. `data-gui-raw` carries
 * the kind, so tests and the conformance kit can tell it apart.
 */
import type { ViewProps } from "../contract";
import { ViewHeader } from "./view-parts";

export function RawView({ model }: ViewProps) {
  return <RawViewAt model={model} depth={0} />;
}

/** At `depth` 1 when KitView meets an unknown kind embedded in a feed, so its heading is not the page's. */
export function RawViewAt({ model, depth }: ViewProps & { depth: number }) {
  return (
    <article className="flex flex-col gap-4" data-gui-raw={model.kind} data-gui-view={model.view}>
      <ViewHeader model={model} depth={depth} />
      <p className="text-body text-muted-foreground">This view needs a newer interface.</p>
    </article>
  );
}
