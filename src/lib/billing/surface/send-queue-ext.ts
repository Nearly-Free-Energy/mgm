/**
 * The `billing.send-queue@1` ext: each bill's payment link, for a renderer
 * that offers it to copy, and the note on why links can or cannot be made,
 * in full. The link is also the row's `link` cell, so a GUI without a
 * renderer for this ext shows it as text a person can select.
 *
 * The link field is `url`, not `link`: "link" is one of the host's href keys
 * (HREF_KEYS in src/lib/gui/host/server/parse.ts), and an ext is data the
 * host never treats as an href (`ext` is in DATA_KEYS there, so no href
 * rule applies inside it), so a name that reads as one would mislead. If
 * `ext` leaves DATA_KEYS, revisit this name and what the url must pass.
 *
 * Strict objects at every depth and every array capped, so the host's ext
 * check (strictProblems in src/lib/gui/host/server/contribution-schema.ts)
 * passes it. A change to this shape is `@2`, named by
 * SEND_QUEUE_EXT_SCHEMA in ./send-queue-model.ts.
 */
import { z } from "zod";
import { PERIOD_REVIEW_MAX_ROWS } from "./period-review-model";

export const SendQueueExt = z.strictObject({
  /** One per model row, in the same order and with the same id (the bill's). Null where the row's link cell is empty. */
  rows: z
    .array(
      z.strictObject({
        id: z.string().max(64),
        url: z
          .string()
          .max(2048)
          .regex(/^https?:\/\/\S+$/)
          .nullable(),
      }),
    )
    .max(PERIOD_REVIEW_MAX_ROWS),
  /** Why links are made from a sandbox account, or why none can be made; null when the payment account is live and ready, or when the period has no bills to send. */
  note: z.strictObject({ tone: z.enum(["info", "warning"]), text: z.string().max(500) }).nullable(),
});

export type SendQueueExtData = z.infer<typeof SendQueueExt>;
