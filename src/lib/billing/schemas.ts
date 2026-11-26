/**
 * Body schemas for billing's write actions. The billing routes parse with
 * these (schemas-routes.test.ts checks it), and BILLING_SURFACE's actions
 * take their input from them, so the GUI form and the routes share one
 * definition. GridTariffEditor still runs its own checks; drop this note if
 * it starts parsing with these schemas.
 * A change to a schema's JSON Schema is a new input version: bump its
 * constant (schemas.test.ts pins each version's shape).
 *
 * Client-safe: besides zod, its runtime imports are day-key.ts, which
 * imports nothing; site-savings.ts, whose runtime imports reach only
 * metering/site-operations.ts and the timezone helpers (day-key.ts,
 * wall-clock.ts); and invoices/config-schema.ts, which imports only zod and,
 * in a browser, turns on zod's jitless mode for every schema (its header
 * says why). Its import from payments/state.ts is type-only. If any of these
 * gains a server-only or side-effecting runtime import, revisit.
 */
import { z } from "zod";
import { isCalendarDateKey } from "@/lib/timezone/day-key";
import { validateGridTariffBands } from "./site-savings";
import type { PaymentStatus } from "@/lib/payments/state";
import { INVOICE_PREFIX_RE, InvoiceConfigSchema } from "@/lib/invoices/config-schema";

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

const DELETE_CONFIRMATION = "confirmation needs the period's name, typed";

/**
 * DELETE /api/billing-periods/[periodId]. The period comes from the path.
 * `confirmation` is the host's Confirmation (src/lib/gui/contract.ts) for a
 * typed action: the period name the person typed (periodName in ./close).
 * Without it the route answers 428. No digest: billing.delete-period's
 * prepare returns none (./surface/periods.ts). If it ever does, add `digest`
 * here and bump the version.
 */
export const DeletePeriodBody = z.strictObject(
  {
    confirmation: z
      .strictObject(
        {
          acknowledged: z
            .array(z.string({ error: DELETE_CONFIRMATION }).max(64, { error: DELETE_CONFIRMATION }), {
              error: DELETE_CONFIRMATION,
            })
            .max(20, { error: DELETE_CONFIRMATION }),
          typed: z.string({ error: DELETE_CONFIRMATION }).max(200, { error: DELETE_CONFIRMATION }).optional(),
        },
        { error: DELETE_CONFIRMATION }
      )
      .optional(),
  },
  { error: bodyError }
);
export const DELETE_PERIOD_BODY_VERSION = 1;

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

/** GenerateBillsBody's keys, in the order today's messages are checked. */
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
 * The input BillingCapability's bill generation parses with (generateBills,
 * and generateFromMeters and billFromReadings through it). It takes no seed
 * readings since version 2: every run it parses for writes behind a guard
 * that refuses them (generate.ts, steps 0a to 0c), and billing review's
 * preview resolves its own (src/lib/cordis/review-seeds.ts).
 */
export const GenerateBillsBody = z
  .strictObject(
    {
      ...periodsGenerationShape,
    },
    { error: periodsBodyError }
  )
  .superRefine(periodsNoManualRevert);
export const GENERATE_BILLS_BODY_VERSION = 2;

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
// ── Bill line items ──

/** A meter quantity in kWh: a finite number, 0 or more. */
const lineItemsKwh = (key: string) =>
  z
    .number({ error: `${key} must be a finite number` })
    .min(0, { error: `${key} must be a non-negative number` });

const ACKNOWLEDGED_CONFIRMATION_ERROR = "confirmation needs the acknowledgements ticked";

/**
 * The host's Confirmation (src/lib/gui/contract.ts) as a ceremony action that
 * asks for no typed name sends it: the acknowledgements ticked. The host
 * hides it from the form. RegenerateBillBody and LineItemUsageBody take it,
 * for the paid-bill acknowledgement (REGENERATE_PAID_ACKNOWLEDGEMENT).
 */
const acknowledgedConfirmation = z
  .strictObject(
    {
      acknowledged: z
        .array(z.string({ error: ACKNOWLEDGED_CONFIRMATION_ERROR }).max(64, { error: ACKNOWLEDGED_CONFIRMATION_ERROR }), {
          error: ACKNOWLEDGED_CONFIRMATION_ERROR,
        })
        .max(20, { error: ACKNOWLEDGED_CONFIRMATION_ERROR }),
    },
    { error: ACKNOWLEDGED_CONFIRMATION_ERROR }
  )
  .optional();

/**
 * PATCH /api/billing-line-items/[lineItemId]/usage. The line item comes from
 * the path. At least one reading key is required; when both are given the
 * route takes end_kwh and ignores usage_kwh, and with end_kwh alone it
 * refuses a reading below the line item's start_kwh, which only the database
 * knows.
 *
 * confirmation: billing.record-usage is a ceremony, and asks a paid bill's
 * correction to be acknowledged (REGENERATE_PAID_ACKNOWLEDGEMENT), as
 * billing.regenerate-bill asks a paid bill's regeneration; the route refuses
 * a paid bill without it (#247). Version 2 added it. It takes no typed name:
 * the ceremony asks for none (prepareRecordUsage), so a body carrying one is
 * refused as an unknown key. If the ceremony comes to ask for a name, add
 * typed here and check it in the route.
 */
export const LineItemUsageBody = z
  .strictObject(
    {
      usage_kwh: lineItemsKwh("usage_kwh").optional().meta({ title: "Usage (kWh)" }),
      end_kwh: lineItemsKwh("end_kwh").optional().meta({ title: "Closing meter reading (kWh)" }),
      confirmation: acknowledgedConfirmation,
    },
    { error: bodyError }
  )
  .refine((body) => body.usage_kwh !== undefined || body.end_kwh !== undefined, {
    error: "At least one of usage_kwh or end_kwh is required",
  });
export const LINE_ITEM_USAGE_BODY_VERSION = 2;

// The payment-status route has always said "a JSON object", with a full stop,
// where bodyError says "an object"; it keeps its wording.
const lineItemsPaymentBodyError = (issue: { code: string; keys?: string[] }) =>
  issue.code === "unrecognized_keys"
    ? `Unknown field: ${(issue.keys ?? []).join(", ")}`
    : "Request body must be a JSON object.";

// Every manual target of the payment state machine but 'link_generated'
// (src/lib/payments/state.ts); the satisfies keeps the list inside it.
const LINE_ITEMS_PAYMENT_STATUSES = ["unpaid", "paid", "failed", "refunded"] as const satisfies readonly PaymentStatus[];

/**
 * PATCH /api/billing-line-items/[lineItemId]/payment-status. The line item
 * comes from the path. 'link_generated' is not a manual input: only the link
 * route sets it. Whether the caller may set 'failed' or 'refunded' is the
 * route's super-admin check, not the body's, so all four values parse.
 * notes is trimmed before its length is checked, and a note that trims to
 * nothing parses as null.
 */
const LINE_ITEMS_CONFIRMATION = "confirmation needs the acknowledgements ticked and the name typed";

export const LineItemPaymentStatusBody = z.strictObject(
  {
    status: z
      .enum(LINE_ITEMS_PAYMENT_STATUSES, {
        error: (issue) =>
          issue.input === undefined
            ? "Missing required field: status."
            : `Invalid status '${String(issue.input)}'. Allowed: ${LINE_ITEMS_PAYMENT_STATUSES.join(", ")}.`,
      })
      .meta({ title: "Payment status" }),
    notes: z
      .string({ error: "notes must be a string." })
      .trim()
      .max(500, { error: "notes must be 500 characters or fewer." })
      .nullish()
      .transform((notes) => (notes ? notes : null))
      .meta({ title: "Notes" }),
    // The host's Confirmation (src/lib/gui/contract.ts), sent with a typed
    // action: billing.mark-refunded asks for the tenant's name, and the
    // route refuses a refund without it (428), whoever sends it; the legacy
    // row menu's refund dialog sends it too. Version 2 added it. typed has
    // no length limit: the route compares it with tenants.display_name, which
    // has none either (TEXT; createTenant and the tenant update only trim
    // it), so any cap here would leave a longer-named tenant's bill with no
    // way to be refunded. If display_name gets a length limit, cap typed at it.
    confirmation: z
      .strictObject(
        {
          acknowledged: z
            .array(z.string({ error: LINE_ITEMS_CONFIRMATION }).max(64, { error: LINE_ITEMS_CONFIRMATION }), {
              error: LINE_ITEMS_CONFIRMATION,
            })
            .max(20, { error: LINE_ITEMS_CONFIRMATION }),
          typed: z.string({ error: LINE_ITEMS_CONFIRMATION }).optional(),
        },
        { error: LINE_ITEMS_CONFIRMATION }
      )
      .optional(),
  },
  { error: lineItemsPaymentBodyError }
);
export const LINE_ITEM_PAYMENT_STATUS_BODY_VERSION = 2;

/**
 * The acknowledgement regenerating a paid bill needs on the regenerate route,
 * and correcting a paid bill's usage on the usage route (#247): the prepares
 * of billing.regenerate-bill and billing.record-usage offer it
 * (src/lib/billing/surface/period-review.ts), and both routes refuse a paid
 * bill without it. POST /api/billing/generate, which the deleted legacy
 * dialogs called, asked for none and rewrote a paid bill as well; the
 * dialogs warned on the client only.
 */
export const REGENERATE_PAID_ACKNOWLEDGEMENT = "regenerate-paid-bill";

/**
 * Why the regenerate route refuses a bill, as fixed copy: the route answers
 * with it and billing.regenerate-bill's availability and prepare explain the
 * same refusal before it happens (src/lib/billing/surface/period-review.ts).
 *  - closed: the period's totals were reviewed and closed; regenerating
 *    would change money a closed period was closed with.
 *  - invoiced: the bill has an invoice number (allocated the first time its
 *    PDF is downloaded, GET /api/billing-line-items/[lineItemId]/pdf), and a
 *    regenerated bill would carry new figures under the number already
 *    issued.
 *  - refunded: refunding then re-billing reads as data corruption.
 *  - changed: the bill changed after the route read it (a payment, a
 *    refund, another regeneration); only the write itself finds this
 *    (fn_regenerate_bill_with_audit).
 *  - paid: not a refusal of the regenerate route, which regenerates a paid
 *    bill once the person acknowledges it is paid; the reason a
 *    whole-period run from meter data (POST
 *    /api/billing-periods/[periodId]/generate-from-meters) leaves a paid
 *    bill as it is, as it leaves an invoiced or refunded one.
 */
export const REGENERATE_REFUSAL_COPY = {
  closed: "Bills in a closed period cannot be regenerated.",
  invoiced: "This bill has been invoiced, so it cannot be regenerated: its invoice number is already issued.",
  refunded: "A refunded bill cannot be regenerated.",
  // fn_regenerate_bill_with_audit found the bill changed between the route's
  // read and the write: paid, refunded or regenerated meanwhile.
  changed: "This bill changed while it was being regenerated. Refresh it and try again.",
  paid: "This bill is marked paid, so it is regenerated only on its own, after confirming that it is paid.",
} as const;

/**
 * Why PATCH /api/billing-line-items/[lineItemId]/usage refuses a correction,
 * as fixed copy: the route answers with it, and billing.record-usage's
 * availability and prepare give the same refusals before it runs
 * (src/lib/billing/surface/period-review.ts). A correction is a per-bill
 * regeneration from manual readings (#247), so it refuses what the
 * regenerate route refuses, in the same order and for the same reasons
 * (REGENERATE_REFUSAL_COPY), and then what only a usage correction needs:
 *  - closed, invoiced, refunded: as REGENERATE_REFUSAL_COPY.
 *  - metered: the bill is from a meter, or the tenant has a meter assigned
 *    in the period; regenerate-bill changes such a bill.
 *  - noStart: the bill has no starting reading for the usage to count from.
 *  - changed: the bill changed after the route read it (a payment, a
 *    refund, an invoice number, a regeneration); only the write finds this
 *    (fn_regenerate_bill_with_audit).
 * A paid bill is not refused: the person acknowledges that it is paid
 * (REGENERATE_PAID_ACKNOWLEDGEMENT).
 */
export const USAGE_REFUSAL_COPY = {
  closed: "Cannot edit a closed period",
  invoiced: "This bill has been invoiced, so its usage cannot be corrected: its invoice number is already issued.",
  refunded: "A refunded bill's usage cannot be corrected.",
  metered: "Use Refresh Readings for metered tenants",
  noStart: "A starting register reading is required before correcting this bill.",
  changed: "This bill changed while its usage was being corrected. Refresh it and try again.",
} as const;

/**
 * Why POST /api/billing-periods/[periodId]/generate-from-meters refuses, as
 * fixed copy: the route answers with it, never with a database's or a
 * metering source's own message. billing.generate-from-meters
 * (src/lib/billing/surface/period-review.ts) gives two of these ahead of
 * time: its availability gives `closed`, and its prepare `closed` and
 * `nothingToRead`. The other three are known only when the route runs,
 * since the prepare pins no tariff and reads no meter; if it comes to,
 * add them to GENERATE_REFUSALS there and say so here.
 *  - closed: a closed period's bills are not generated again; the bill
 *    engine refuses it too (guardExistingBills in ./generate.ts).
 *  - noTariff: the microgrid has no rate schedule to pin.
 *  - meters: the metering source could not be read, so nothing was written.
 *  - failed: anything else, including bills that could not be read.
 *  - nothingToRead: no tenant's meter would be read (prepare), or the
 *    microgrid has no tenants (route).
 */
export const GENERATE_FROM_METERS_COPY = {
  closed: "Bills cannot be generated in a closed period.",
  noTariff: "This microgrid has no rate schedule to bill with. Add one under Rate Schedule first.",
  meters: "Could not read the meters right now. Nothing was changed. Try again shortly.",
  failed: "Bills could not be generated. Refresh the period to see its bills, and try again.",
  nothingToRead: "There is nothing to read from meters for this period.",
  // The period was deleted while the run wrote (period_not_found in ./generate.ts).
  periodNotFound: "Billing period not found.",
} as const;

/**
 * Why a tenant with no bill is not billed from readings typed by hand, as
 * fixed copy: POST
 * /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings
 * answers with it, never with a database's own message, and
 * billing.bill-from-readings' availability (`closed`) and prepare (`closed`,
 * `tenantNotFound`, `otherMicrogrid`, `hasBill`) give the same refusals
 * before it runs (src/lib/billing/surface/not-billed.ts). The bill engine
 * gives `closed`, `hasBill`, `periodNotFound` and `failed` itself
 * (newBillOnly in ./generate.ts).
 *  - closed: a closed period's totals were reviewed and closed.
 *  - hasBill: the tenant already has a bill for the period; regenerating
 *    that bill (billing.regenerate-bill, manual readings) changes it.
 *  - otherMicrogrid: the tenant belongs to another microgrid than the
 *    period's.
 *  - tenantNotFound: no tenant the person can read has that id.
 *  - periodNotFound: no period the person can read has that id, as the
 *    route reads it, or the period was deleted before the insert
 *    (period_not_found in ./generate.ts).
 *  - noTariff: the microgrid has no rate schedule to pin.
 *  - tariffChanged: the period's tariff changed between the pin and the
 *    write (fn_record_line_item_with_audit).
 *  - failed: anything else, including bills that could not be read.
 */
export const BILL_FROM_READINGS_COPY = {
  closed: "Bills cannot be added to a closed period.",
  hasBill: "This tenant already has a bill for this period. Regenerate that bill to change its readings.",
  otherMicrogrid: "This tenant is not on this period's microgrid.",
  tenantNotFound: "Tenant not found.",
  periodNotFound: GENERATE_FROM_METERS_COPY.periodNotFound,
  noTariff: GENERATE_FROM_METERS_COPY.noTariff,
  tariffChanged: "The period's tariff changed while the bill was calculated. Nothing was written. Try again.",
  failed: "The bill could not be written. Refresh the period to see its bills, and try again.",
} as const;

/**
 * POST /api/billing-periods/[periodId]/generate-from-meters. The period comes
 * from the path, and the run takes nothing else: every tenant's bill is read
 * from its meter (BillingCapability.generateFromMeters). The body is the empty
 * object the GUI host sends for an action bound only through its path
 * (invoke.ts); a confirm-level action is sent no confirmation, so any key is
 * refused. If the action comes to take readings, a confirmation or a choice
 * of tenants, add them here and bump the version.
 */
export const GenerateFromMetersBody = z.strictObject({}, { error: bodyError });
export const GENERATE_FROM_METERS_BODY_VERSION = 1;

/**
 * POST /api/billing-line-items/[lineItemId]/regenerate. Flat, so the kit
 * form can render it, and an object of fields, so the GUI host can check the
 * period review's prefills against it field by field (cleanPrefill in
 * src/lib/gui/host/server/merge.ts); the route checks which readings each
 * mode takes.
 */
export const RegenerateBillBody = z.strictObject(
  {
    readings: z
      .enum(["edge", "manual"], { error: "readings must be 'edge' or 'manual'" })
      .meta({ title: "Readings" }),
    start_kwh: lineItemsKwh("start_kwh").optional().meta({ title: "Start reading (kWh)" }),
    end_kwh: lineItemsKwh("end_kwh").optional().meta({ title: "End reading (kWh)" }),
    reason: z
      .string({ error: "reason must be a string" })
      .trim()
      .max(500, { error: "reason must be 500 characters or fewer" })
      .optional()
      .meta({ title: "Reason" }),
    // The host's Confirmation (src/lib/gui/contract.ts), sent with a
    // ceremony action: billing.regenerate-bill asks a paid bill's
    // regeneration to be acknowledged (REGENERATE_PAID_ACKNOWLEDGEMENT), and
    // this route refuses a paid bill without it. The host hides it from
    // the form. Version 2 added it. It takes no typed name: the ceremony
    // asks for none (prepareRegenerateBill), so the host sends none, and a
    // body carrying one is refused as an unknown key. If the ceremony comes
    // to ask for a name, add typed here and check it in the route.
    confirmation: acknowledgedConfirmation,
  },
  { error: bodyError }
);
export const REGENERATE_BILL_BODY_VERSION = 2;

/**
 * POST /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings:
 * the start and end readings typed by hand for a tenant with no bill, and
 * why, as the legacy pre-flight panel's manual rows take them. The period
 * and tenant come from the path. Decimals are accepted (the bill engine
 * stores kWh to 3 places) and no upper bound is set, as in
 * GenerateBillsBody's manual readings and on the regenerate route. The route checks that
 * end_kwh is not below start_kwh. Flat and without an object-level
 * refinement, so the kit renders it and the GUI host can check a prefill
 * (cleanPrefill in src/lib/gui/host/server/merge.ts); if a refinement is
 * added, a prefill is dropped: revisit. No confirmation: a confirm-level
 * action is sent none (sendsConfirmation in
 * src/lib/gui/host/client/invoke.ts), so one is refused as an unknown key;
 * if invoke.ts comes to send a confirmation at confirm level, add it here,
 * or every submit from the GUI is refused.
 */
export const BillFromReadingsBody = z.strictObject(
  {
    start_kwh: lineItemsKwh("start_kwh").meta({ title: "Start reading (kWh)" }),
    end_kwh: lineItemsKwh("end_kwh").meta({ title: "End reading (kWh)" }),
    reason: z
      .string({ error: "reason must be a string" })
      .trim()
      .max(500, { error: "reason must be 500 characters or fewer" })
      .optional()
      .meta({ title: "Reason" }),
  },
  { error: bodyError }
);
export const BILL_FROM_READINGS_BODY_VERSION = 1;
// ── Tariffs and invoice settings ──

const TARIFFS_TIERS = "tiers must be a non-empty array (at least 1 tier required)";
const TARIFFS_SERVICE_CHARGE = "service_charge must be a number >= 0";
const TARIFFS_TAX_RATE = "tax_rate must be a number between 0 and 1 (inclusive)";

const tariffsNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * The first fault in a rate schedule's tiers, or null. The checks and their
 * order are the ones the rate-schedule routes have always made, tier by tier:
 * min_kwh, rate_per_kwh, a number max_kwh on every tier but the last, then
 * contiguity with the tier before. A tier's label, the last tier's max_kwh and
 * any other keys are not checked, and are stored as sent: TierEditor sends
 * back what it loaded, including tiers saved without a label.
 */
function tariffsTierFault(tiers: unknown[]): string | null {
  const at = (i: number): Record<string, unknown> => {
    const tier = tiers[i];
    return tier !== null && typeof tier === "object" ? (tier as Record<string, unknown>) : {};
  };
  for (let i = 0; i < tiers.length; i++) {
    const tier = at(i);
    if (!tariffsNumber(tier.min_kwh) || tier.min_kwh <= 0) {
      return `Tier ${i + 1}: min_kwh must be greater than 0`;
    }
    if (!tariffsNumber(tier.rate_per_kwh) || tier.rate_per_kwh <= 0) {
      return `Tier ${i + 1}: rate_per_kwh must be greater than 0`;
    }
    if (i < tiers.length - 1 && !tariffsNumber(tier.max_kwh)) {
      return `Tier ${i + 1}: only the last tier may have max_kwh null`;
    }
    const previousMax = i > 0 ? at(i - 1).max_kwh : undefined;
    if (typeof previousMax === "number" && tier.min_kwh !== previousMax + 1) {
      return `Tier ${i + 1}: min_kwh must be ${previousMax + 1} (contiguous with tier ${i})`;
    }
  }
  return null;
}

// A tier is z.unknown() and the whole list is checked by one refine, so that
// the first fault reported, and its "Tier N:" message, are the ones above;
// per-tier schemas would report a type fault in a later tier before a
// contiguity fault in an earlier one.
const tariffsScheduleShape = {
  tiers: z
    .array(z.unknown(), { error: TARIFFS_TIERS })
    .min(1, { error: TARIFFS_TIERS })
    .superRefine((tiers, ctx) => {
      const fault = tariffsTierFault(tiers);
      if (fault) ctx.addIssue({ code: "custom", message: fault });
    })
    .meta({
      title: "Tiers",
      description:
        "In order, each { label, min_kwh, max_kwh, rate_per_kwh }: min_kwh and rate_per_kwh above 0, each min_kwh one more than the previous max_kwh, and max_kwh null only on the last tier.",
    }),
  service_charge: z
    .number({ error: TARIFFS_SERVICE_CHARGE })
    .min(0, { error: TARIFFS_SERVICE_CHARGE })
    .meta({ title: "Service charge" }),
  tax_rate: z
    .number({ error: TARIFFS_TAX_RATE })
    .min(0, { error: TARIFFS_TAX_RATE })
    .max(1, { error: TARIFFS_TAX_RATE })
    .meta({ title: "Tax rate", description: "A fraction: 0.18 is 18%." }),
};

/**
 * POST /api/rate-schedules. Each tier is stored as sent, with whatever keys it
 * has (see tariffsTierFault).
 */
export const CreateRateScheduleBody = z.strictObject(
  {
    microgrid_id: z.guid({ error: "microgrid_id must be a valid UUID" }),
    ...tariffsScheduleShape,
  },
  { error: bodyError }
);
export const CREATE_RATE_SCHEDULE_BODY_VERSION = 1;

/**
 * PUT /api/rate-schedules/[id]: a new version of the schedule in the path, for
 * the same microgrid. A microgrid_id in the body is refused as unknown.
 */
export const ReviseRateScheduleBody = z.strictObject(tariffsScheduleShape, { error: bodyError });
export const REVISE_RATE_SCHEDULE_BODY_VERSION = 1;

const TARIFFS_PREFIX_TYPE = "invoice_prefix must be a string or null.";
const TARIFFS_PREFIX_FORMAT = "Invoice prefix must be 2-8 uppercase letters or digits (e.g. NFE, ACME01).";

/**
 * invoice_config, parsed by InvoiceConfigSchema (src/lib/invoices/config-schema.ts),
 * whose output is what is stored: unknown keys at its top level are refused
 * and unknown keys inside its sections are dropped. Any fault in it answers
 * with `message` alone, as these routes always have, rather than the first
 * zod message, which often does not name the setting. The transform only
 * reports the fault; the pipe's InvoiceConfigSchema parses, and is what the
 * JSON Schema describes.
 */
const tariffsInvoiceConfig = (message: string) =>
  z
    .transform((value: unknown, ctx) => {
      if (!InvoiceConfigSchema.safeParse(value).success) {
        ctx.issues.push({ code: "custom", message, input: value });
      }
      return value;
    })
    .pipe(InvoiceConfigSchema)
    .meta({ title: "Invoice settings" });

/**
 * PATCH /api/communities/[id]/invoice-config. The community comes from the
 * path. invoice_prefix is INVOICE_PREFIX_RE, the regex of the column's CHECK
 * (migration 00033), or null to clear it.
 */
export const SaveInvoiceSettingsBody = z.strictObject(
  {
    invoice_prefix: z
      .string({ error: TARIFFS_PREFIX_TYPE })
      .regex(INVOICE_PREFIX_RE, { error: TARIFFS_PREFIX_FORMAT })
      .nullable()
      .meta({ title: "Invoice prefix" }),
    invoice_config: tariffsInvoiceConfig("Invoice configuration is invalid. See the highlighted fields."),
  },
  { error: bodyError }
);
export const SAVE_INVOICE_SETTINGS_BODY_VERSION = 1;

/**
 * INVOICE_PREFIX_RE or the empty string, which the preview reads as no
 * prefix. schemas-tariffs.test.ts checks the two agree; if INVOICE_PREFIX_RE
 * changes, change this.
 */
const TARIFFS_PREVIEW_PREFIX_RE = /^(?:[A-Z0-9]{2,8})?$/;

/**
 * POST /api/communities/[id]/invoice-preview: the invoice settings form's
 * unsaved state, rendered to a PDF and not stored. Unlike the PATCH body, an
 * empty invoice_prefix is accepted and the route reads it as null.
 */
export const PreviewInvoiceBody = z.strictObject(
  {
    invoice_prefix: z
      .string({ error: TARIFFS_PREFIX_TYPE })
      .regex(TARIFFS_PREVIEW_PREFIX_RE, { error: TARIFFS_PREFIX_FORMAT })
      .nullable()
      .meta({ title: "Invoice prefix" }),
    // This copy promises that saving shows which setting is wrong. Neither
    // the PATCH route (one message, like this one) nor the settings form
    // does; it is kept as it was. Reword it when one of them changes.
    invoice_config: tariffsInvoiceConfig(
      "Invoice configuration is invalid. Save your changes to see the field errors."
    ),
  },
  { error: bodyError }
);
export const PREVIEW_INVOICE_BODY_VERSION = 1;
