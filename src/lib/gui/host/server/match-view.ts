import "server-only";

/**
 * Which contributed view an href's path names. Its own module so that the
 * assistant reference rule (./assistant-references.ts), which signals.ts
 * imports, can match a path without importing ./view.ts, which imports
 * signals.ts.
 */
import type { RegisteredView } from "./surface-registry";

/**
 * The view whose path fits `path`, with its segment values decoded. Where two
 * fit, a fixed segment beats a bracketed one at the first position they
 * differ, as matchCatalogPage (src/lib/plugins/bundled.ts) ranks pages.
 */
export function matchView(
  views: readonly RegisteredView[],
  path: string,
): { view: RegisteredView; values: Record<string, string> } | undefined {
  let parts: string[];
  try {
    parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  let best: { view: RegisteredView; values: Record<string, string>; rank: string } | undefined;
  for (const view of views) {
    const segments = view.def.path.split("/").filter(Boolean);
    if (segments.length !== parts.length) continue;
    const values: Record<string, string> = {};
    let rank = "";
    const fits = segments.every((segment, i) => {
      const name = /^\[(.+)\]$/.exec(segment)?.[1];
      rank += name ? "0" : "1";
      if (name) values[name] = parts[i];
      return name !== undefined || segment === parts[i];
    });
    if (fits && (!best || rank > best.rank)) best = { view, values, rank };
  }
  return best && { view: best.view, values: best.values };
}
