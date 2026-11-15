/**
 * The `billing.savings@1` ext: what a bespoke renderer of the savings needs
 * beyond the tiles to draw them as the Operations page's table: its column
 * and row headings, the warnings and the notes, all formatted on the server.
 *
 * Strict objects at every depth and every array capped, so the host's ext
 * check (strictProblems in src/lib/gui/host/server/contribution-schema.ts)
 * passes it. A change to this shape is `@2`, named by SAVINGS_EXT_SCHEMA in
 * ./savings-model.ts.
 */
import { z } from "zod";
import { SAVINGS_COLUMNS, SAVINGS_ROWS } from "./savings-model";

const text = (max: number) => z.string().max(max);

export const SavingsExt = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ready"),
    synthetic: z.boolean(),
    /** Each tile is keyed `<column>.<row>`, such as "day.solar". */
    columns: z.array(z.strictObject({ id: z.enum(SAVINGS_COLUMNS), label: text(60), sub: text(80).nullable() })).max(3),
    rows: z
      .array(z.strictObject({ id: z.enum(SAVINGS_ROWS), label: text(60), sub: text(160).nullable(), strong: z.boolean() }))
      .max(4),
    /** Days with no grid tariff, and the one-year cap on the read. */
    warnings: z.array(text(200)).max(2),
    /** What each figure means. */
    notes: z.array(text(600)).max(3),
  }),
  z.strictObject({ state: z.literal("setup"), synthetic: z.boolean(), title: text(80), text: text(400) }),
  /** The day above already explains why there are no figures, so nothing is drawn. */
  z.strictObject({ state: z.literal("unavailable"), synthetic: z.boolean() }),
]);

export type SavingsExtData = z.infer<typeof SavingsExt>;
