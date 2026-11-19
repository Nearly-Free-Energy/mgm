/**
 * The `billing.period-review@1` ext: the figures a person copies from the
 * period's bills, for a renderer that draws them as a copy table. Each is a
 * plain machine number (no grouping, a "." decimal point, no unit): kWh to 3
 * decimals as the CSV export writes it, and money in the currency's minor
 * unit, which matches the CSV only for a currency with none, such as UGX
 * (copyFigure in ./period-review-model.ts says why). The layout comes from
 * the model's columns, not from here.
 *
 * Strict objects at every depth and every array capped, so the host's ext
 * check (strictProblems in src/lib/gui/host/server/contribution-schema.ts)
 * passes it. A change to this shape is `@2`, named by
 * PERIOD_REVIEW_EXT_SCHEMA in ./period-review-model.ts.
 */
import { z } from "zod";
import { PERIOD_REVIEW_MAX_COPY_COLUMNS, PERIOD_REVIEW_MAX_ROWS } from "./period-review-model";

const FIGURE = z.string().regex(/^-?\d{1,15}(\.\d{1,6})?$/);
const COLUMN = z.string().regex(/^(begin|end|usage|total|tier\.([1-9]|1\d|20)\.(kwh|amount))$/);

export const PeriodReviewExt = z.strictObject({
  /** The copy columns, in table order: every column the model marks copy "bare". Each row's figures and the totals follow this order. */
  columns: z.array(COLUMN).max(PERIOD_REVIEW_MAX_COPY_COLUMNS),
  /** One per model row, in the same order and with the same id (the bill's). Null where the cell is empty. */
  rows: z
    .array(z.strictObject({ id: z.string().max(64), figures: z.array(FIGURE.nullable()).max(PERIOD_REVIEW_MAX_COPY_COLUMNS) }))
    .max(PERIOD_REVIEW_MAX_ROWS),
  /** The totals' figures, null for a column with no total (begin, end); empty with no bills. */
  totals: z.array(FIGURE.nullable()).max(PERIOD_REVIEW_MAX_COPY_COLUMNS),
});

export type PeriodReviewExtData = z.infer<typeof PeriodReviewExt>;
