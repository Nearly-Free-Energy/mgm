/**
 * Body schemas for billing's write actions. The billing routes parse with
 * these (schemas-routes.test.ts checks it). A form that offers one of these
 * actions should parse with the same schema; GridTariffEditor still runs its
 * own checks, so revisit this when it or a GUI surface imports this module.
 * A change to a schema's JSON Schema is a new input version: bump its
 * constant (schemas.test.ts pins each version's shape).
 *
 * Client-safe: besides zod it imports site-savings.ts, which imports only
 * types, and day-key.ts, which imports nothing; if either gains a runtime
 * import, revisit.
 */
import { z } from "zod";
import { isCalendarDateKey } from "@/lib/timezone/day-key";
import { validateGridTariffBands } from "./site-savings";

const bodyError = (issue: { code: string; keys?: string[] }) =>
  issue.code === "unrecognized_keys"
    ? `Unknown field: ${(issue.keys ?? []).join(", ")}`
    : "Request body must be an object";

/**
 * A calendar day, YYYY-MM-DD. z.iso.date() also accepts the years 0000 to
 * 0099, which isCalendarDateKey refuses; the refine keeps the two in step.
 */
const calendarDay = (message: string) =>
  z.iso.date({ error: message }).refine(isCalendarDateKey, { error: message });

// The band messages are validateGridTariffBands' own. For a body with one
// fault the route answers with the validator's text (schemas.test.ts compares
// them); with several faults, or an hour beyond 2^53, the first message
// reported can differ from the validator's.
const WHOLE = "Band hours must be whole hours.";
const HOURS = "Each band must start before it ends, between hour 0 and hour 24.";
const RATE = "Each band's rate must be a number of 0 or more.";
const BAND_COUNT = "A tariff needs between 1 and 24 bands.";

export const GridTariffBandBody = z.strictObject(
  {
    from_hour: z
      .int({ error: WHOLE })
      .min(0, { error: HOURS })
      .max(23, { error: HOURS })
      .meta({ title: "From hour" }),
    to_hour: z
      .int({ error: WHOLE })
      .min(1, { error: HOURS })
      .max(24, { error: HOURS })
      .meta({ title: "To hour" }),
    rate: z.number({ error: RATE }).min(0, { error: RATE }).meta({ title: "Rate per kWh" }),
  },
  { error: "Each band needs a start hour, an end hour and a rate." }
);

/** POST /api/microgrids/[id]/grid-tariffs. The microgrid comes from the path. */
export const AddGridTariffBody = z.strictObject(
  {
    effective_from: calendarDay("effective_from must be a date (YYYY-MM-DD)").meta({
      title: "Effective from",
    }),
    bands: z
      .array(GridTariffBandBody, { error: "Bands must be a list." })
      .min(1, { error: BAND_COUNT })
      .max(24, { error: BAND_COUNT })
      // Contiguous 0-24 coverage; the database checks only the array's length.
      .superRefine((bands, ctx) => {
        const checked = validateGridTariffBands(bands);
        if (!checked.ok) ctx.addIssue({ code: "custom", message: checked.message });
      })
      .meta({ title: "Bands" }),
  },
  { error: bodyError }
);
export const ADD_GRID_TARIFF_BODY_VERSION = 1;

const EFFICIENCY = "round_trip_efficiency must be a number greater than 0 and at most 1";

/** PUT /api/microgrids/[id]/savings-settings. Replaces the row; all three keys are required. */
export const SaveSavingsSettingsBody = z.strictObject(
  {
    solar_savings_from: calendarDay("solar_savings_from must be a date (YYYY-MM-DD) or null")
      .nullable()
      .meta({ title: "Count solar savings from" }),
    arbitrage_from: calendarDay("arbitrage_from must be a date (YYYY-MM-DD) or null")
      .nullable()
      .meta({ title: "Count battery arbitrage from" }),
    round_trip_efficiency: z
      .number({ error: EFFICIENCY })
      .gt(0, { error: EFFICIENCY })
      .lte(1, { error: EFFICIENCY })
      // numeric(4,3): a value that rounds to 0 would fail the column's CHECK.
      .refine((v) => Math.round(v * 1000) > 0, { error: EFFICIENCY })
      .meta({ title: "Battery round-trip efficiency", description: "A fraction: 0.9 is 90%." }),
  },
  { error: bodyError }
);
export const SAVE_SAVINGS_SETTINGS_BODY_VERSION = 1;
