/**
 * Marks every Value in a loader's model as synthetic, for a view whose
 * figures come from generated rather than measured data. Pure and
 * client-safe; it imports only types.
 *
 * Covers the Values each view kind's body holds: tile values and statuses,
 * cells and totals, record fields, and in a feed entry both the Values in
 * its rich text and those in a values embed. A series
 * point has no marker, so a view with a series says so in its own `ext`.
 * If a body kind gains a Value position, add it here.
 */
import type { Inline, Rich, Value } from "./contract";
import type { LoadedModel } from "./surface";

const mark = (value: Value): Value => ({ ...value, synthetic: true });
const markRecord = (values: Record<string, Value>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, mark(value)]));

const markInline = (inline: Inline): Inline =>
  typeof inline === "object" && "value" in inline ? { value: mark(inline.value) } : inline;
const markRich = (rich: Rich): Rich =>
  rich.map((block) => ("p" in block ? { p: block.p.map(markInline) } : { li: block.li.map(markInline) }));

type AnyBody = LoadedModel<"collection" | "record" | "metrics" | "feed" | "flow">["body"];

function markBody(body: AnyBody): AnyBody {
  if ("tiles" in body) {
    return {
      ...body,
      tiles: body.tiles.map((tile) => ({
        ...tile,
        value: mark(tile.value),
        ...(tile.status ? { status: mark(tile.status) } : {}),
      })),
    };
  }
  if ("rows" in body) {
    return {
      ...body,
      rows: body.rows.map((row) => ({ ...row, cells: markRecord(row.cells) })),
      ...(body.totals ? { totals: markRecord(body.totals) } : {}),
    };
  }
  if ("sections" in body) {
    return {
      sections: body.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) => ({ ...field, value: mark(field.value) })),
      })),
    };
  }
  if ("entries" in body) {
    return {
      ...body,
      entries: body.entries.map((entry) => ({
        ...entry,
        text: markRich(entry.text),
        ...(entry.embed?.type === "values"
          ? { embed: { ...entry.embed, values: entry.embed.values.map(mark) } }
          : {}),
      })),
    };
  }
  return body;
}

export function markSynthetic<M extends LoadedModel<"collection" | "record" | "metrics" | "feed" | "flow">>(
  model: M,
): M {
  return { ...model, body: markBody(model.body) };
}
