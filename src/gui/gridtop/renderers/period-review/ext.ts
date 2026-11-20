/**
 * The part of the `billing.period-review@1` ext this renderer reads: the
 * figure a person copies from each copy column, for each row and for the
 * totals. The host has already parsed the ext strictly against its schema
 * (PeriodReviewExt in src/lib/billing/surface/period-review-ext.ts, which a
 * GUI package may not import), so this only checks what the renderer relies
 * on: that the figures line up with the model's columns and rows. A change
 * to that schema is version 2, which this renderer does not read.
 */
import type { Json, ModelOf, ViewModel } from "@/lib/gui/contract";

export const PERIOD_REVIEW_EXT = "billing.period-review@1";

/** Plain machine numbers: no grouping, a "." decimal point, no unit; null where the cell is empty. */
export type PeriodReviewFigures = {
  /** The keys of the model's copy columns, in table order. */
  columns: string[];
  /** One per model row, in the same order. */
  rows: { id: string; figures: (string | null)[] }[];
  /** One per copy column, or none when the model has no totals. */
  totals: (string | null)[];
};

const FIGURE = /^-?\d+(\.\d+)?$/;
const isObject = (v: Json | undefined): v is { [key: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const figuresOf = (v: Json | undefined, n: number): (string | null)[] | null =>
  Array.isArray(v) && v.length === n && v.every((f) => f === null || (typeof f === "string" && FIGURE.test(f))) ? (v as (string | null)[]) : null;

/** The keys of the columns a person copies, in table order. */
export const copyColumns = (model: ModelOf<"collection">): string[] => model.body.columns.filter((c) => c.copy === "bare").map((c) => c.key);

/** The figures, or null when the model is not this view at version 1 or they do not line up with its columns and rows. */
export function readPeriodReviewExt(model: ViewModel): PeriodReviewFigures | null {
  if (model.kind !== "collection" || model.ext?.schema !== PERIOD_REVIEW_EXT) return null;
  const d = model.ext.data;
  if (!isObject(d) || !Array.isArray(d.columns) || !Array.isArray(d.rows)) return null;
  const keys = copyColumns(model);
  if (d.columns.length !== keys.length || d.columns.some((k, i) => k !== keys[i])) return null;
  const { rows } = model.body;
  if (d.rows.length !== rows.length) return null;
  const read: PeriodReviewFigures["rows"] = [];
  for (const [i, row] of d.rows.entries()) {
    if (!isObject(row) || row.id !== rows[i].id) return null;
    const figures = figuresOf(row.figures, keys.length);
    if (!figures) return null;
    read.push({ id: rows[i].id, figures });
  }
  // No totals in the model, none in the ext.
  const totals = model.body.totals ? figuresOf(d.totals, keys.length) : figuresOf(d.totals, 0);
  if (!totals) return null;
  return { columns: keys, rows: read, totals };
}

/** Joins class names; not ../../ui/cx, for the reason ./view.tsx gives. */
export const cls = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");
