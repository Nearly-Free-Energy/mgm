/**
 * Body schemas for billing's write actions. The billing routes parse with
 * these (schemas-routes.test.ts checks it), and BILLING_SURFACE's actions
 * take their input from them, so the GUI form and the routes share one
 * definition. GridTariffEditor still runs its own checks; drop this note if
 * it starts parsing with these schemas.
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
      // Contiguous 0-24 coverage. The database's trigger on grid_tariffs
      // (migration 20261115110000) checks the same rules with the same
      // messages; if this changes, change it in a new migration.
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

const CONFIRMATION = "confirmation needs the digest of the reviewed totals and the acknowledgements ticked";

/**
 * POST /api/billing-periods/[periodId]/close. The period comes from the path.
 * `confirmation` is the host's Confirmation (src/lib/gui/contract.ts): the
 * digest of the totals the person reviewed, the acknowledgements they ticked
 * and the period name they typed. Without it the route answers 428 with the
 * review to confirm (src/lib/billing/close.ts).
 */
export const ClosePeriodBody = z.strictObject(
  {
    confirmation: z
      .strictObject(
        {
          digest: z.string({ error: CONFIRMATION }).min(1, { error: CONFIRMATION }).max(200, { error: CONFIRMATION }),
          acknowledged: z
            .array(z.string({ error: CONFIRMATION }).max(64, { error: CONFIRMATION }), { error: CONFIRMATION })
            .max(20, { error: CONFIRMATION }),
          typed: z.string({ error: CONFIRMATION }).max(200, { error: CONFIRMATION }).optional(),
        },
        { error: CONFIRMATION }
      )
      .optional(),
  },
  { error: bodyError }
);
export const CLOSE_PERIOD_BODY_VERSION = 1;

// ── Billing periods and bill generation ──

const PERIODS_RANGE = "start_date and end_date must be YYYY-MM-DD with start_date <= end_date.";

/**
 * POST /api/billing-periods. The period's time zone is not a body field:
 * BillingCapability.createPeriod stamps it from the microgrid. The
 * capability parses with this schema too, for callers that reach it without
 * the route.
 */
export const CreatePeriodBody = z
  .strictObject(
    {
      microgrid_id: z.guid({ error: "microgrid_id must be a valid UUID." }).meta({ title: "Microgrid" }),
      start_date: calendarDay(PERIODS_RANGE).meta({ title: "Start date" }),
      end_date: calendarDay(PERIODS_RANGE).meta({ title: "End date" }),
    },
    { error: bodyError }
  )
  // Equal dates are a one-day period. Runs only once both dates parsed.
  .refine((b) => b.start_date <= b.end_date, { error: PERIODS_RANGE, path: ["start_date"] });
export const CREATE_PERIOD_BODY_VERSION = 1;

/**
 * The generation routes' messages predate these schemas and name the body
 * and each list entry by position ("manualReadings[2].endKwh …"); the
 * clients show them as they come.
 */
const periodsBodyError = (issue: { code: string; keys?: string[] }) =>
  issue.code === "unrecognized_keys"
    ? `Unknown field: ${(issue.keys ?? []).join(", ")}`
    : "Body must be an object";

/**
 * An error for an entry of `list`, naming its index. zod 4.6 writes the
 * message once the issue has its full path, so the index is the first number
 * in it; parsing an entry schema on its own gives "?". If a zod upgrade
 * writes messages earlier, the indexed cases in schemas-periods.test.ts fail.
 */
const periodsEntryError =
  (list: string, rest: string) =>
  (issue: { path?: PropertyKey[] }) => {
    const index = issue.path?.find((p) => typeof p === "number");
    return `${list}[${index === undefined ? "?" : String(index)}]${rest}`;
  };

/** An entry object: unknown keys are refused by name, anything else is not an object. */
const periodsEntryObjectError =
  (list: string) =>
  (issue: { code: string; keys?: string[]; path?: PropertyKey[] }) =>
    issue.code === "unrecognized_keys"
      ? periodsEntryError(list, ` has an unknown field: ${(issue.keys ?? []).join(", ")}`)(issue)
      : periodsEntryError(list, " must be an object")(issue);

/** A meter reading in kWh: a finite number of 0 or more (z.number refuses NaN and Infinity). */
const periodsKwh = (list: string, key: string) => {
  const error = periodsEntryError(list, `.${key} must be a non-negative finite number`);
  return z.number({ error }).min(0, { error });
};

const periodsTenantIds = (key: string) =>
  z.array(z.guid({ error: `${key} entries must be UUID strings` }), {
    error: `${key} must be an array of UUIDs`,
  });

const PeriodsManualReading = z
  .strictObject(
    {
      tenantId: z
        .guid({ error: periodsEntryError("manualReadings", ".tenantId must be a UUID") })
        .meta({ title: "Tenant" }),
      startKwh: periodsKwh("manualReadings", "startKwh").meta({ title: "Start reading (kWh)" }),
      endKwh: periodsKwh("manualReadings", "endKwh").meta({ title: "End reading (kWh)" }),
      reason: z
        .string({ error: periodsEntryError("manualReadings", ".reason must be a string") })
        .max(500, { error: periodsEntryError("manualReadings", ".reason must be <= 500 chars") })
        .optional()
        .meta({ title: "Reason" }),
    },
    { error: periodsEntryObjectError("manualReadings") }
  )
  .refine((m) => m.endKwh >= m.startKwh, {
    error: periodsEntryError("manualReadings", ".endKwh must be >= startKwh"),
    path: ["endKwh"],
  });

/**
 * Checks the shape of a seed and that `startKwh <= dialReadingKwh` (no
 * negative usage since the period began). It does not re-derive startKwh
 * from OpenEMS, so a wrong startKwh that still sits below the dial reading
 * is accepted; the inputs travel with it so a wrong seed stays diagnosable.
 */
const PeriodsSeedReading = z
  .strictObject(
    {
      deviceId: z
        .guid({ error: periodsEntryError("seedReadings", ".deviceId must be a UUID") })
        .meta({ title: "Meter" }),
      dialReadingKwh: periodsKwh("seedReadings", "dialReadingKwh").meta({ title: "Meter dial reading (kWh)" }),
      startKwh: periodsKwh("seedReadings", "startKwh").meta({ title: "Start reading (kWh)" }),
      // Date.parse, not z.iso.datetime: clients send a bare date such as 2026-08-20.
      readAt: z
        .string({ error: periodsEntryError("seedReadings", ".readAt must be an ISO timestamp") })
        .refine((v) => !Number.isNaN(Date.parse(v)), {
          error: periodsEntryError("seedReadings", ".readAt must be an ISO timestamp"),
        })
        .meta({ title: "Read at" }),
    },
    { error: periodsEntryObjectError("seedReadings") }
  )
  .refine((r) => r.startKwh <= r.dialReadingKwh, {
    error: periodsEntryError("seedReadings", ".startKwh cannot exceed dialReadingKwh"),
    path: ["startKwh"],
  });

/** The keys previewing and generating share, in the order today's messages are checked. */
const periodsGenerationShape = {
  billingPeriodId: z.guid({ error: "billingPeriodId must be a UUID string" }).meta({ title: "Billing period" }),
  // Absent: every tenant on the period's microgrid. []: nobody.
  tenantIds: periodsTenantIds("tenantIds").optional().meta({ title: "Tenants" }),
  manualReadings: z
    .array(PeriodsManualReading, { error: "manualReadings must be an array" })
    .optional()
    .meta({ title: "Manual readings" }),
  revertToEdgeTenantIds: periodsTenantIds("revertToEdgeTenantIds")
    .optional()
    .meta({ title: "Switch back to edge data" }),
};

/** A tenant cannot be both re-entered by hand and switched back to OpenEMS in one request. */
function periodsNoManualRevert(
  body: { manualReadings?: { tenantId: string }[]; revertToEdgeTenantIds?: string[] },
  ctx: z.RefinementCtx
) {
  const manual = new Set(body.manualReadings?.map((m) => m.tenantId));
  const both = body.revertToEdgeTenantIds?.find((id) => manual.has(id));
  if (both !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: `Tenant ${both} cannot be in both manualReadings and revertToEdgeTenantIds`,
      path: ["revertToEdgeTenantIds"],
    });
  }
}

/**
 * POST /api/billing/regenerate-preview. Generation's body without
 * seedReadings: the route has never passed seeds to the preview, so it
 * refuses them rather than drop them unread. If it starts passing them,
 * parse with GenerateBillsBody instead.
 */
export const PreviewBillsBody = z
  .strictObject(periodsGenerationShape, { error: periodsBodyError })
  .superRefine(periodsNoManualRevert);
export const PREVIEW_BILLS_BODY_VERSION = 1;

/**
 * POST /api/billing/generate. BillingCapability.generateBills and
 * previewBills parse with it too, for callers that reach the capability
 * without a route.
 */
export const GenerateBillsBody = z
  .strictObject(
    {
      ...periodsGenerationShape,
      seedReadings: z
        .array(PeriodsSeedReading, { error: "seedReadings must be an array" })
        // One seed per device: taking the last of two would make the reading
        // used depend on array order. Runs only once every entry parsed.
        .superRefine((seeds, ctx) => {
          const seen = new Set<string>();
          for (const seed of seeds) {
            if (seen.has(seed.deviceId)) {
              ctx.addIssue({ code: "custom", message: `seedReadings has more than one entry for device ${seed.deviceId}` });
              return;
            }
            seen.add(seed.deviceId);
          }
        })
        .optional()
        .meta({ title: "Starting readings" }),
    },
    { error: periodsBodyError }
  )
  .superRefine(periodsNoManualRevert);
export const GENERATE_BILLS_BODY_VERSION = 1;

/**
 * The most tenants one billing review compares. POST /api/billing-review/preview
 * refuses a longer tenantIds list as a bad body, and answers 413 when the
 * list is omitted and the microgrid has more tenants than this.
 */
export const BILLING_REVIEW_MAX_TENANTS = 500;

const PERIODS_REVIEW_BODY = `periodId and tenantIds must be UUIDs; tenantIds is limited to ${BILLING_REVIEW_MAX_TENANTS} entries`;

/**
 * POST /api/billing-review/preview. The route takes no readings and no
 * provider from the caller: it picks the OpenEMS provider itself. If it
 * ever takes either from the body, add the key here. Every fault but an
 * unknown key answers with the one message.
 */
export const PreviewBillingReviewBody = z.strictObject(
  {
    periodId: z.guid({ error: PERIODS_REVIEW_BODY }).meta({ title: "Billing period" }),
    tenantIds: z
      .array(z.guid({ error: PERIODS_REVIEW_BODY }), { error: PERIODS_REVIEW_BODY })
      .max(BILLING_REVIEW_MAX_TENANTS, { error: PERIODS_REVIEW_BODY })
      .optional()
      .meta({ title: "Tenants" }),
  },
  {
    error: (issue: { code: string; keys?: string[] }) =>
      issue.code === "unrecognized_keys" ? bodyError(issue) : PERIODS_REVIEW_BODY,
  }
);
export const PREVIEW_BILLING_REVIEW_BODY_VERSION = 1;
