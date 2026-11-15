/**
 * The views Gridtop draws with a bespoke renderer, and the `ext` versions
 * each reads. Kept apart from the renderers, so the window bar can tell that
 * the page's renderer places its own actions and links without loading it.
 */
import type { Id, ViewModel } from "@/lib/gui/contract";

export const RENDERER_READS = {
  "metering.site-day": [1],
} as const satisfies Partial<Record<Id, readonly number[]>>;

/**
 * Whether Gridtop draws `model` with a bespoke renderer. This copies the
 * host's choice (pickRenderer in src/lib/gui/host/shared/pick-renderer.ts),
 * which a GUI package may not import; if that rule changes, change this too.
 */
export function drawnBespoke(model: Pick<ViewModel, "view" | "ext">): boolean {
  if (!model.ext || !Object.prototype.hasOwnProperty.call(RENDERER_READS, model.view)) return false;
  const reads: readonly number[] = RENDERER_READS[model.view as keyof typeof RENDERER_READS];
  const at = model.ext.schema.lastIndexOf("@");
  const version = at < 0 ? NaN : Number(model.ext.schema.slice(at + 1));
  return Number.isInteger(version) && version >= 0 && reads.includes(version);
}
