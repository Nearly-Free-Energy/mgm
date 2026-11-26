import "server-only";

/**
 * generate.ts — shared billing-line-item generation engine (#173, BC1).
 *
 * This module owns the per-tenant compute + (optionally) write loop that
 * used to live inline in the session route `POST /api/billing/generate`
 * (removed once nothing called it, #201). Its callers:
 *
 *   1. Billing review's preview (src/lib/cordis/billing-review.ts, for POST
 *      /api/billing-review/preview) — mode='preview', the one unguarded
 *      run, which writes nothing.
 *      `tenantIds`: undefined → all metered/un-metered tenants on the
 *      period's microgrid; `[]` → explicit no-op; `[uuid, …]` → only those.
 *      `manualReadings`: per-tenant `{ startKwh, endKwh, reason? }`
 *      overrides — implicit add to the processed set; the OpenEMS call is
 *      skipped for these tenants.
 *
 *      `revertToEdgeTenantIds`: tenants whose current manual row may
 *      be replaced by an OpenEMS reading (see "Manual rows" below). It lifts
 *      that guard only; it does not add a tenant to the processed set.
 *
 *      Returns the in-memory calc + previousTotalAmount/previousPaymentStatus
 *      from the prior line item; writes nothing.
 *
 *   Every write is guarded (mode='write' with none of the three below is
 *   refused before anything is read, #247). Two callers rewrite one existing
 *   bill only as they read it (`expectedBill`), with the same body as a
 *   preview: `BillingCapability.generateBills`, for `POST
 *   /api/billing-line-items/[lineItemId]/regenerate` (#243), and `PATCH
 *   /api/billing-line-items/[lineItemId]/usage`, the single-cell manual
 *   edit, which names its bill's one tenant and that tenant's manual
 *   reading (#247). `POST
 *   /api/billing-periods/[periodId]/generate-from-meters` runs a whole
 *   period from meter data (`guardExistingBills`), and `POST
 *   /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings`
 *   bills one tenant who has no bill from readings typed by hand, and
 *   refuses one who has (`newBillOnly`). Their params below say how.
 *
 *   The unguarded write, which upserted over any bill in any period, served
 *   `POST /api/billing/generate` (#201), `POST /api/v1/billing/generate`
 *   (#241) and, last, the usage route; it went once that route became a
 *   per-bill regeneration (#247).
 *
 * ── Write semantics (mode='write') ──────────────────────────────────────────
 *
 * A bill that exists goes through fn_regenerate_bill_with_audit, which
 * rewrites it only as it was read, and otherwise passes its arguments on to
 * `fn_record_line_item_with_audit` (00029). That function UPSERTs by
 * (billing_period_id, tenant_id), preserving payment_status / paid_at /
 * paid_by_user_id / payment_* columns on UPDATE, so a regenerate doesn't
 * clobber a paid row's audit fields and doesn't cascade away its
 * payment_events history, and writes one row to billing_audit_log in the
 * same transaction. A tenant with no bill as read (guardExistingBills,
 * newBillOnly) gets one through fn_record_first_line_item_with_audit
 * (migration 20261120130100), which inserts only while the period is a
 * draft and the tenant has no bill, under the period's lock, and never
 * overwrites a bill (`firstBillRefusal` maps its refusals). Both write the
 * same columns and audit row as the upsert. The engine no longer calls
 * fn_record_line_item_with_audit itself.
 *
 * The audit row's details (LineItemRegeneratedDetails, previous_snapshot
 * included) are built by those functions from the bill they write and the
 * bill it replaces, read under their own lock (migration
 * 20261124170000), so the engine sends `_audit_details: null`. For a
 * signed-in caller they also require the manual bill's
 * `_entered_by_user_id` and the actor to be the caller.
 *
 * The legacy bulk-only delete-then-insert path is REMOVED — this is the
 * critical AC3 change.
 *
 * ── Manual rows (Q5) ───────────────────────────────────────────────────────
 *
 * A tenant whose line item in this period already has
 * `reading_source='manual'` is left untouched unless the request either
 * supplies a `manualReadings` entry for it (a new manual reading) or names
 * it in `revertToEdgeTenantIds` (switch back to OpenEMS). Otherwise:
 *
 *   - bulk run (`tenantIds` undefined): the tenant is reported as
 *     `kind: 'kept'`. Refresh Readings re-reads every metered tenant, and
 *     a saved manual reading is not a stale one — keeping it is the expected
 *     outcome, not a failure.
 *   - explicit `tenantIds` naming it: reported as an error with
 *     `code: 'currently_manual'`, because the caller asked for that
 *     tenant specifically and did not get what it asked for.
 *
 * Kept and refused tenants are not read from the metering provider.
 * BC3's per-row "Switch back to edge data" is the path that sends
 * `revertToEdgeTenantIds`.
 *
 * ── Cross-microgrid attack defense ─────────────────────────────────────────
 *
 * `manualReadings[].tenantId` that resolves to a tenant NOT in the
 * period's microgrid is surfaced in `errors[]` with `code: 'unknown_tenant'`
 * and dropped before any RPC call. RLS would also reject the write, but
 * failing fast at the route is clearer + saves a round-trip.
 *
 * ── INVARIANT (added 2026-05 with #250) ────────────────────────────────────
 *
 * A caller that runs the engine on a service-role client gets no RLS
 * backstop for the cross-microgrid check above — it is then the SOLE
 * defense against cross-microgrid tenant submission. Do NOT delete on the
 * assumption that RLS will catch it; RLS only fires for user-bound clients.
 * See PR #246 review + #250 ticket body for the original reasoning.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateTieredCost } from "@/lib/billing/calculations";
import { roundKwh, roundAmount } from "@/lib/billing/precision";
import type { DeviceConfig } from "@/lib/adapters/types";
import { MeteringError } from "@/lib/metering/errors";
import type { MeteringProvider } from "@/lib/metering/types";
import type {
  BillingLineItem,
  BillingPeriod,
  RateSchedule,
  ReadingSource,
  TierBreakdown,
  TierConfig,
  BillingLineItemPaymentStatus,
} from "@/lib/types/domain";
import { coversPeriod, overlapsPeriod } from "./meter-coverage";
import { BILL_FROM_READINGS_COPY, GENERATE_FROM_METERS_COPY, REGENERATE_REFUSAL_COPY } from "./schemas";
import { chunked, pageAfter, readAllPages } from "./surface/pages";

// ── Public types ────────────────────────────────────────────────────────────

export type GenerationMode = "write" | "preview";

export type ManualReadingInput = {
  tenantId: string;
  startKwh: number;
  endKwh: number;
  reason?: string;
};

/**
 * A meter reading taken by the operator, used to establish `start_kwh` for a
 * device whose billing history predates its OpenEMS connection (#339).
 *
 * Not staged in the database — supplied per-request, exactly like
 * `ManualReadingInput`. The panel that collects these holds them in component
 * state until Generate.
 *
 * `dialReadingKwh` / `readAt` are the operator's inputs and `startKwh` is
 * derived from them:
 *
 *     startKwh = dialReadingKwh − usage(period.start_date → readAt)
 *
 * All three are sent. The derived value is what generation uses; the inputs
 * are what make a wrong seed diagnosable a year later rather than anonymous.
 * GenerateBillsBody checks only that startKwh does not exceed dialReadingKwh;
 * nothing recomputes startKwh from the inputs, so
 * the client's arithmetic is trusted. If a server-side recomputation is
 * added, say so here.
 *
 * `readAt` is NOT "now". An operator can read a dial in the morning and type
 * it that evening, and the subtraction is over the interval that actually
 * elapsed. Minutes do not matter; days do.
 */
export type SeedReadingInput = {
  deviceId: string;
  dialReadingKwh: number;
  readAt: string;
  startKwh: number;
};

export type GenerationErrorCode =
  | "currently_manual"
  | "no_meter_reading"
  | "line_item_write_failed"
  | "tariff_changed"
  | "missing_openems_config"
  | "invalid_manual_reading"
  | "unmetered_no_manual"
  | "meter_assignment_continuity"
  | "unknown_tenant"
  /**
   * A per-bill regeneration (`expectedBill`), or a whole-period one
   * (`guardExistingBills`) rewriting a bill it read, found the bill no
   * longer as it was read: its period closed, it was invoiced, or its
   * payment status or figures changed (fn_regenerate_bill_with_audit).
   * Nothing was written. A whole-period run also reports `invoiced` for a
   * bill it found invoiced when it read it, and leaves that bill alone.
   * `period_closed` is also a guarded run's first bill for a tenant refused
   * because the period closed after the run's last read of its status
   * (fn_record_first_line_item_with_audit).
   */
  | "period_closed"
  | "invoiced"
  | "bill_changed"
  /**
   * A whole-period run (`guardExistingBills`) found the bill paid or
   * refunded and left it as it is, unread from the meter: regenerating a
   * paid bill needs its own acknowledged regeneration, and a refunded bill
   * is not regenerated at all (REGENERATE_REFUSAL_COPY).
   */
  | "paid"
  | "refunded"
  /**
   * A first bill from readings typed by hand (`newBillOnly`) found the
   * tenant already billed for the period, as it read the period's bills; or
   * a guarded run's first bill for a tenant found, at its insert, a bill
   * another write had added since the read
   * (fn_record_first_line_item_with_audit). Nothing was written: that bill
   * is changed by regenerating it.
   */
  | "bill_exists"
  /**
   * A guarded run's first bill for a tenant, or a first bill from readings,
   * found no period at its insert (fn_record_first_line_item_with_audit's
   * billing_period_not_found): the period was deleted after the run read
   * it. Nothing was written.
   */
  | "period_not_found"
  /**
   * #339. The device has no prior MGM `end_kwh` and no seed was supplied, so
   * `start_kwh` is unknowable. Previously this fell to `?? 0`, which asserted
   * the meter read zero at period start and printed that on the invoice.
   *
   * Refusing is deliberate: "I have no record" and "the meter read zero" are
   * different claims, and only one of them is safe to print on a document a
   * customer checks against the box on their wall.
   */
  | "needs_seed_reading";

export type WrittenTenantResult = {
  kind: "written";
  tenantId: string;
  tenantName: string;
  lineItem: BillingLineItem;
  previousTotalAmount: number | null;
  previousPaymentStatus: BillingLineItemPaymentStatus | null;
  previousReadingSource: ReadingSource | null;
};

export type PreviewTenantResult = {
  kind: "preview";
  tenantId: string;
  tenantName: string;
  startKwh: number | null;
  endKwh: number | null;
  usageKwh: number;
  tierBreakdown: TierBreakdown[];
  totalAmount: number;
  previousUsageKwh: number | null;
  previousTotalAmount: number | null;
  previousPaymentStatus: BillingLineItemPaymentStatus | null;
};

/**
 * A per-bill regeneration (`expectedBill`) whose new figures are the ones the
 * bill already has: nothing was written and no audit row was added, so
 * sending the same regeneration twice records it once.
 */
export type UnchangedTenantResult = {
  kind: "unchanged";
  tenantId: string;
  tenantName: string;
  lineItemId: string;
  totalAmount: number;
};

/** A currently-manual tenant that a bulk run left as it was (Q5). */
export type KeptTenantResult = {
  kind: "kept";
  tenantId: string;
  tenantName: string;
  readingSource: "manual";
};

export type ErrorTenantResult = {
  kind: "error";
  tenantId: string;
  tenantName: string;
  error: string;
  code: GenerationErrorCode;
  /**
   * Set only by a guarded whole-period run (`guardExistingBills`), when the
   * tenant had a bill as the run read it. An error writes nothing, so that
   * bill is left as it was: a tenant whose meter could not be read keeps
   * the bill it had, rather than going unbilled.
   */
  hadBill?: true;
};

export type TenantResult =
  | WrittenTenantResult
  | PreviewTenantResult
  | KeptTenantResult
  | ErrorTenantResult
  | UnchangedTenantResult;

export type GenerationResult = {
  results: TenantResult[];
};

export type RunGenerationParams = {
  supabase: SupabaseClient;
  periodId: string;
  /** undefined = all tenants on the microgrid; `[]` = explicit no-op. */
  tenantIds?: string[];
  /** Per-tenant reading overrides. Tenants here are implicitly added
   *  to the processed set. */
  manualReadings?: ManualReadingInput[];
  /** Tenants whose current manual row may be replaced by an OpenEMS
   *  reading. Lifts the manual-row guard only; does NOT add a tenant to
   *  the processed set. */
  revertToEdgeTenantIds?: string[];
  /** Operator-supplied starting readings, keyed by device (#339). */
  seedReadings?: SeedReadingInput[];
  mode: GenerationMode;
  /** Resolved `auth.uid()` from the route's session. Required when
   *  mode='write' (passed to RPC as actor + entered_by_user_id for manual).
   *
   *  For non-human callers (future cron jobs, etc.) pass `null` and set
   *  `actorKind` + `actorRef`. The DB CHECK on `billing_audit_log`
   *  enforces the (kind, user_id, ref) shape (see migration 00041 / #250). */
  actorUserId: string | null;
  /** Defaults to `'human'` for backwards compatibility with all existing
   *  in-app callers (the dashboard routes). `'system'` is for webhook
   *  ingestors. See migration 00041 (#250). */
  actorKind?: "human" | "system";
  /** Opaque caller-supplied identifier — source key (e.g.
   *  `'pesapal_ipn'`) for system. Required by DB CHECK whenever
   *  `actorKind != 'human'`. */
  actorRef?: string | null;
  /**
   * Explicit, request-scoped metering dependency. Billing never constructs a
   * vendor client or resolves provider configuration itself. Manual-only runs
   * do not need one.
   */
  meteringProvider?: MeteringProvider;
  /** Bill from a trusted period usage total when no absolute register is known. */
  allowUsageOnlyReadings?: boolean;
  /** MGM review databases record meter-assignment dates. Fail closed when a
   *  single assignment does not cover the entire period. Legacy schemas
   *  do not have these columns, so this check is opt-in. */
  requireEffectiveDatedAssignments?: boolean;
  /**
   * A per-bill regeneration: the bill as the caller read it before deciding
   * to rewrite it (POST /api/billing-line-items/[lineItemId]/regenerate).
   * When set, the run names that bill's one tenant, writes through
   * fn_regenerate_bill_with_audit, which refuses unless the period is still
   * a draft and the bill still has no invoice number and these values, under
   * locks held to commit, and writes nothing when the new figures are the
   * ones the bill already has (`kind: 'unchanged'`).
   * BillingCapability.generateBills and PATCH
   * /api/billing-line-items/[lineItemId]/usage always set it. A write sets
   * it, guardExistingBills or newBillOnly, or is refused; a preview ignores it.
   */
  expectedBill?: ExpectedBill;
  /**
   * A whole-period run from meter data that changes an existing bill only
   * as it was read (POST /api/billing-periods/[periodId]/generate-from-meters,
   * through BillingCapability.generateFromMeters). Only in write mode, for
   * every tenant (no tenantIds) and with no manual readings, reverts, seeds
   * or expectedBill; otherwise the run is refused before anything is read.
   * When set:
   *  - a period that is not a draft is refused (409 billing_period_closed);
   *  - a bill with an invoice number, a paid bill and a refunded bill are
   *    left as they are and not read from the meter, reported as errors
   *    with the codes invoiced, paid and refunded (manual bills are kept,
   *    as on any whole-period run);
   *  - every other existing bill is written as a per-bill regeneration with
   *    that bill as read here as its expectedBill: through
   *    fn_regenerate_bill_with_audit, refused under its locks if the bill
   *    or its period changed since, and not written at all (`unchanged`, no
   *    audit row) when its figures are already the ones computed, so a
   *    second run writes nothing. A bill with a pending payment link
   *    (link_generated) is rewritten too, as Refresh Readings rewrote it:
   *    when its total changes, fn_record_line_item_with_audit clears its
   *    Pesapal link, and fn_payment_bill_revision sets any open checkout
   *    of the bill to needs_reconciliation (summarizeGenerateFromMeters
   *    counts those bills, and the confirmation warns of them; if either
   *    function changes what it does on a new total, revisit both);
   *  - an existing bill whose meter cannot be read (no meter, an assignment
   *    gap, no data) is not written: its error carries `hadBill`;
   *  - the period's status is read again after the meters are read and
   *    before the first write, and the run is refused the same way, with
   *    nothing written, if it is no longer a draft;
   *  - a tenant with no bill gets one through
   *    fn_record_first_line_item_with_audit, which takes the period's lock
   *    and inserts only while the period is a draft and the tenant has no
   *    bill: a close that commits after the second read above refuses the
   *    insert (`period_closed`, GENERATE_FROM_METERS_COPY.closed), and a bill
   *    another write inserted for that tenant after this run read the
   *    period's bills (a bill from readings, or a second run overlapping
   *    this one) is left as it is (`bill_exists`), with nothing written
   *    for that tenant;
   * A preview leaves it unset and checks none of this.
   */
  guardExistingBills?: boolean;
  /**
   * A first bill for one tenant from readings typed by hand (POST
   * /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings,
   * through BillingCapability.billFromReadings). Only in write mode, with
   * tenantIds exactly that one tenant and one manual reading for them, and
   * no reverts, seeds, expectedBill or guardExistingBills; otherwise the run
   * is refused before anything is read. When set:
   *  - a period that is not a draft is refused (409 billing_period_closed),
   *    before the tariff pin;
   *  - the period's tenants and bills are read in full, every page, and a
   *    read that cannot be completed stops the run with nothing written
   *    (500, BILL_FROM_READINGS_COPY.failed);
   *  - a tenant who already has a bill, as the period's bills are read here,
   *    is refused with `bill_exists` and nothing is written: that bill is
   *    changed by regenerating it (POST
   *    /api/billing-line-items/[lineItemId]/regenerate);
   *  - the period's status is read again just before the insert, as for
   *    guardExistingBills, and the run is refused the same way, with nothing
   *    written, if it is no longer a draft;
   *  - otherwise the manual path below runs unchanged: the same tariff pin,
   *    rounding and audit row as a per-bill regeneration's.
   * The insert is fn_record_first_line_item_with_audit's, as for
   * guardExistingBills above: under the period's lock it refuses a period
   * that closed after that second read (`period_closed`,
   * BILL_FROM_READINGS_COPY.closed) and a bill another write inserted for
   * this tenant after the read of the period's bills here (`bill_exists`,
   * BILL_FROM_READINGS_COPY.hasBill), writing nothing.
   */
  newBillOnly?: boolean;
};

/**
 * The bill a per-bill regeneration read (RunGenerationParams.expectedBill):
 * its payment status and every column fn_record_line_item_with_audit writes
 * but entered_at, which are the columns sameBill below compares. Two copies of
 * one regeneration sent at once both read the bill before either writes, so
 * both find it needs writing; the second write then finds one of these
 * changed and is refused. A column sameBill compares and this leaves out would
 * let the second write too, adding a second audit row: if sameBill or that
 * function gains a column, add it here and to fn_regenerate_bill_with_audit's
 * comparison (20261119090000_regenerate_bill_expected_state.sql).
 */
export type ExpectedBill = {
  lineItemId: string;
  tenantId: string;
  paymentStatus: BillingLineItemPaymentStatus;
  totalAmount: number;
  usageKwh: number | null;
  startKwh: number | null;
  endKwh: number | null;
  readingSource: ReadingSource | null;
  deviceId: string | null;
  /** As read: the write compares it with the stored JSON as it is. */
  tierBreakdown: unknown;
  enteredByUserId: string | null;
  manualReason: string | null;
};

export type RunGenerationFatal =
  | { kind: "fatal"; status: number; body: { error: string; code?: string } };

export type RunGenerationOutput = GenerationResult | RunGenerationFatal;

export function isRunGenerationFatal(
  out: RunGenerationOutput
): out is RunGenerationFatal {
  return (out as RunGenerationFatal).kind === "fatal";
}

// ── Internal types (kept private) ───────────────────────────────────────────

type TenantRow = {
  id: string;
  display_name: string;
  tenant_devices: {
    role: string;
    effective_from?: string;
    effective_to?: string | null;
    devices: {
      id: string;
      openems_component_id: string | null;
      edges: {
        openems_edge_id: string | null;
      } | null;
    } | null;
  }[];
};

type PriorItem = {
  id: string;
  tenant_id: string;
  total_amount: number;
  payment_status: BillingLineItemPaymentStatus;
  reading_source: ReadingSource;
  end_kwh: number | null;
  device_id: string | null;
  // Read for sameBill and expectedFromPrior, which compare every column the
  // write sets. The SELECT below must read these too: readAllPages<PriorItem>
  // does not check the shape, so widening this type without widening the
  // SELECT would compile but resolve `undefined` at runtime.
  start_kwh: number | null;
  usage_kwh: number | null;
  /** JSONB — shape is `TierBreakdown[]` in the live row; kept `unknown`
   *  and compared as stored. */
  tier_breakdown: unknown;
  entered_by_user_id: string | null;
  manual_reason: string | null;
  /** Read for `guardExistingBills`, which leaves an invoiced bill alone. */
  invoice_number: string | null;
};

// ── Implementation ──────────────────────────────────────────────────────────

/** A run that could not read its tenants, bills or prior readings (in full). */
const UNREADABLE_COPY = "The period's tenants and bills could not be read. Nothing was written; try again.";

/**
 * Compute (and optionally persist) billing line items for a billing period.
 *
 * Returns a `RunGenerationFatal` for whole-request errors (bad period, bad
 * status, RLS-hidden, OpenEMS misconfig). Returns a `GenerationResult` whose
 * `results` array is one entry per tenant (kind: 'written' | 'preview' |
 * 'error').
 */
export async function runGenerationFor(
  params: RunGenerationParams
): Promise<RunGenerationOutput> {
  const { supabase, periodId, mode, actorUserId } = params;
  const actorKind = params.actorKind ?? "human";
  const actorRef = params.actorRef ?? null;
  const tenantIdsParam = params.tenantIds;
  const manualReadingsParam = params.manualReadings ?? [];
  const revertToEdgeSet = new Set(params.revertToEdgeTenantIds ?? []);
  // #339. Keyed by device, not tenant: a seed is a reading of a specific
  // physical meter, and the same tenant can change meters.
  const seedByDevice = new Map<string, SeedReadingInput>();
  for (const s of params.seedReadings ?? []) seedByDevice.set(s.deviceId, s);

  // ── 0. Every write is guarded ─────────────────────────────────────────────
  // A write rewrites a bill only as it was read (expectedBill,
  // guardExistingBills) or inserts a first bill (guardExistingBills,
  // newBillOnly). A write with none of them would upsert over any bill in
  // any period, which no caller may do any more (#247); a caller that sends
  // one has a bug, so it is refused before anything is read.
  const guardExistingBills = params.guardExistingBills === true;
  if (mode === "write" && params.expectedBill === undefined && !guardExistingBills && params.newBillOnly !== true) {
    return {
      kind: "fatal",
      status: 500,
      body: { error: "A bill is written only as it was read, or as a tenant's first bill.", code: "unguarded_write" },
    };
  }

  // ── 0a. A guarded whole-period run reads every tenant from its meter ───────
  if (
    guardExistingBills &&
    (mode !== "write" ||
      tenantIdsParam !== undefined ||
      manualReadingsParam.length > 0 ||
      revertToEdgeSet.size > 0 ||
      (params.seedReadings ?? []).length > 0 ||
      params.expectedBill !== undefined)
  ) {
    return {
      kind: "fatal",
      status: 400,
      body: { error: "A whole-period run from meter data names no tenants and takes no readings.", code: "guard_existing_bills_mismatch" },
    };
  }

  // ── 0b. A per-bill regeneration names its one tenant and nothing else ──────
  // No other tenant in tenantIds, manualReadings or revertToEdgeTenantIds,
  // and no seeds: it must not become a run over more than its bill.
  const expectedBill = mode === "write" ? params.expectedBill : undefined;
  if (
    expectedBill &&
    (tenantIdsParam?.length !== 1 ||
      tenantIdsParam[0] !== expectedBill.tenantId ||
      manualReadingsParam.some((m) => m.tenantId !== expectedBill.tenantId) ||
      [...revertToEdgeSet].some((id) => id !== expectedBill.tenantId) ||
      (params.seedReadings ?? []).length > 0)
  ) {
    return {
      kind: "fatal",
      status: 400,
      body: { error: "A per-bill regeneration names its bill's one tenant.", code: "expected_bill_mismatch" },
    };
  }

  // ── 0c. A first bill from readings names one tenant and their readings ────
  const newBillOnly = params.newBillOnly === true;
  const newBillTenant = tenantIdsParam?.length === 1 ? tenantIdsParam[0] : undefined;
  if (
    newBillOnly &&
    (mode !== "write" ||
      newBillTenant === undefined ||
      manualReadingsParam.length !== 1 ||
      manualReadingsParam[0].tenantId !== newBillTenant ||
      revertToEdgeSet.size > 0 ||
      (params.seedReadings ?? []).length > 0 ||
      params.expectedBill !== undefined ||
      guardExistingBills)
  ) {
    return {
      kind: "fatal",
      status: 400,
      body: { error: "A first bill from readings names one tenant and that tenant's readings only.", code: "new_bill_only_mismatch" },
    };
  }

  // A guarded run's or a first bill's refusal of a period that is not (or
  // no longer) a draft, each in its own action's copy.
  const periodClosed = (): RunGenerationFatal => ({
    kind: "fatal",
    status: 409,
    body: { error: newBillOnly ? BILL_FROM_READINGS_COPY.closed : GENERATE_FROM_METERS_COPY.closed, code: "billing_period_closed" },
  });
  // A read the run depends on (tenants, bills, prior readings, the period's
  // status again) that could not be completed: nothing has been written, and
  // the run stops rather than go on from part of the rows. Fixed copy, never
  // the database's.
  const unreadable = (code: string): RunGenerationFatal => ({
    kind: "fatal",
    status: 500,
    body: {
      error: guardExistingBills
        ? GENERATE_FROM_METERS_COPY.failed
        : newBillOnly
          ? BILL_FROM_READINGS_COPY.failed
          : UNREADABLE_COPY,
      code,
    },
  });

  // ── 0. Empty-array short-circuit (AC3 explicit no-op) ─────────────────────
  // `tenantIds: []` AND `manualReadings: []` is a well-defined no-op.
  if (
    tenantIdsParam !== undefined &&
    tenantIdsParam.length === 0 &&
    manualReadingsParam.length === 0
  ) {
    return { results: [] };
  }

  // ── 1. Fetch billing period (RLS gates access) ────────────────────────────
  const { data: periodRow, error: periodError } = await supabase
    .from("billing_periods")
    .select("*")
    .eq("id", periodId)
    .single();

  if (periodError || !periodRow) {
    return {
      kind: "fatal",
      status: 404,
      body: { error: "Billing period not found" },
    };
  }
  const billingPeriod = periodRow as BillingPeriod & {
    rate_schedule_id?: string | null;
  };

  // No write changes a closed period's bills. A preview still computes one
  // (Q4=B, #173: the legacy reject was removed, and the upsert that wrote a
  // closed period went in #247). A per-bill regeneration (expectedBill)
  // refuses it under its write's lock (fn_regenerate_bill_with_audit); its
  // callers refuse it first. A guarded
  // whole-period run refuses it here, before the tariff pin, and again after
  // reading the meters, before the first write (6b below); each of its
  // writes checks it again under the period's lock
  // (fn_regenerate_bill_with_audit for a bill that exists,
  // fn_record_first_line_item_with_audit for a first bill). A first bill from
  // readings is refused the same way, with its own copy (periodClosed), and
  // checked again at 6b and at its insert too.
  if ((guardExistingBills || newBillOnly) && billingPeriod.status !== "draft") return periodClosed();

  // ── 2. Resolve the period's pinned rate schedule ─────────────────────────
  // A period must never silently reprice against the microgrid's latest
  // schedule. An empty draft follows the latest version until its first bill,
  // including in preview so preview and write use the same selected tariff.
  let rateScheduleId = billingPeriod.rate_schedule_id ?? null;
  // The RPC locks the period and leaves billed/closed pins intact.
  if (!rateScheduleId || billingPeriod.status === "draft") {
    const { data: pinnedScheduleId, error: pinError } = await supabase.rpc(
      "fn_pin_billing_period_rate_schedule",
      { _period_id: billingPeriod.id }
    );
    if (pinError || !pinnedScheduleId) {
      return {
        kind: "fatal",
        status: 409,
        body: {
          error: pinError?.message ?? "Billing period has no pinned rate schedule.",
          code: "RATE_SCHEDULE_UNPINNED",
        },
      };
    }
    rateScheduleId = pinnedScheduleId as string;
  }

  // ── 3. Fetch the pinned rate schedule ────────────────────────────────────
  const { data: schedule, error: scheduleError } = await supabase
    .from("rate_schedules")
    .select("*")
    .eq("id", rateScheduleId)
    .eq("microgrid_id", billingPeriod.microgrid_id)
    .maybeSingle();

  if (scheduleError || !schedule) {
    return {
      kind: "fatal",
      status: 400,
      body: { error: "No rate schedule found for this microgrid" },
    };
  }
  const rateSchedule = schedule as RateSchedule;

  // ── 4. Fetch tenants on the period's microgrid (LEFT join) ─────────────
  // Every page (readAllPages): PostgREST answers at most max_rows rows and
  // says nothing when it stops, and a tenant missing from this read would
  // be missing from the run.
  const tenantsRaw = await readAllPages<TenantRow>((after) =>
    pageAfter(
      supabase
        .from("tenants")
        .select(
          `
      id,
      display_name,
      tenant_devices(
        role,
        ${params.requireEffectiveDatedAssignments ? "effective_from, effective_to," : ""}
        devices(
          id,
          openems_component_id,
          edges(
            openems_edge_id
          )
        )
      )
    `,
          { count: "exact" },
        )
        .eq("microgrid_id", billingPeriod.microgrid_id)
        .eq("tenant_devices.role", "primary_consumption_meter"),
      after,
    ),
  );
  if (tenantsRaw === null) return unreadable("billing_tenants_unreadable");

  const tenantsAll = tenantsRaw;
  const tenantNames = new Map<string, string>(
    tenantsAll.map((h) => [h.id, h.display_name])
  );

  // The legacy path uses only its original relation columns. MGM review opts
  // into effective-date checks before using a primary meter for a period.
  type ResolvedDevice = {
    deviceId: string;
    edgeOpenemsId: string;
    componentId: string;
  };
  const tenantToDevice = new Map<string, ResolvedDevice | null>();
  const tenantEndDevice = new Map<string, string>();
  const tenantAssignmentErrors = new Map<string, string>();

  for (const h of tenantsAll) {
    const primaryAssignments = h.tenant_devices.filter(
      (hd) => hd.role === "primary_consumption_meter"
    );
    let primaryHD: TenantRow["tenant_devices"][number] | undefined =
      primaryAssignments[0];
    if (params.requireEffectiveDatedAssignments && primaryAssignments.length > 0) {
      // A manually reconciled replacement period still belongs to the meter
      // assigned at its end; preserve that identity for later register lookup.
      const endAssignment = primaryAssignments.find(
        (assignment) =>
          Boolean(assignment.effective_from) &&
          assignment.effective_from! <= billingPeriod.end_date &&
          (assignment.effective_to == null ||
            assignment.effective_to > billingPeriod.end_date)
      );
      if (endAssignment?.devices?.id) {
        tenantEndDevice.set(h.id, endAssignment.devices.id);
      }
      // Assignments are half-open DATE ranges [effective_from, effective_to),
      // while billing_periods stores inclusive end dates. Historical links
      // outside this period must not make a later or earlier period ambiguous.
      // meterCoverage (./meter-coverage.ts) makes the same choice for
      // billing.generate-from-meters' confirmation.
      const overlappingAssignments = primaryAssignments.filter((assignment) =>
        overlapsPeriod(assignment, billingPeriod)
      );
      const coveringAssignments = overlappingAssignments.filter((assignment) =>
        coversPeriod(assignment, billingPeriod)
      );

      if (overlappingAssignments.length === 0) {
        // MGM must surface the gap so the operator can reconcile it. A
        // current link created after a historical billing period is not
        // evidence that it covered that period.
        primaryHD = undefined;
        if (params.allowUsageOnlyReadings) {
          tenantAssignmentErrors.set(
            h.id,
            "No meter assignment covers this billing period; verify the historical meter and its effective dates or enter a manual reading."
          );
        }
      } else if (coveringAssignments.length !== 1) {
        tenantToDevice.set(h.id, null);
        tenantAssignmentErrors.set(
          h.id,
          "No single meter assignment covers the complete billing period; verify replacement boundaries and readings."
        );
        continue;
      } else {
        primaryHD = coveringAssignments[0];
      }
    }
    if (!primaryHD || !primaryHD.devices) {
      tenantToDevice.set(h.id, null);
      continue;
    }
    const device = primaryHD.devices;
    const edge = device.edges;
    if (!edge?.openems_edge_id || !device.openems_component_id) {
      // Metered link exists but config is incomplete — treat as misconfig
      // for the OpenEMS path. A `manualReadings` override still wins and
      // routes the tenant through the manual path.
      tenantToDevice.set(h.id, null);
      continue;
    }
    tenantToDevice.set(h.id, {
      deviceId: device.id,
      edgeOpenemsId: edge.openems_edge_id,
      componentId: device.openems_component_id,
    });
  }

  // ── 4. Compute the processed tenant set ───────────────────────────────
  // - undefined → all microgrid tenants
  // - explicit list → use it, plus implicit add from manualReadings
  // - empty list (with no manualReadings) was caught above
  const manualByTenant = new Map<string, ManualReadingInput>();
  for (const m of manualReadingsParam) {
    manualByTenant.set(m.tenantId, m);
  }

  const microgridTenantIdSet = new Set(tenantsAll.map((h) => h.id));

  const baseSet =
    tenantIdsParam === undefined
      ? new Set<string>(tenantsAll.map((h) => h.id))
      : new Set<string>(tenantIdsParam);

  // Implicit add from manualReadings.
  for (const id of manualByTenant.keys()) {
    baseSet.add(id);
  }

  // ── 4b. Cross-microgrid attack defense ────────────────────────────────────
  // Any tenant id (from caller-supplied tenantIds OR manualReadings)
  // that is NOT in the period's microgrid → surface as 'unknown_tenant'
  // and drop. This closes the cross-org smuggling attack at the route.
  const unknownTenantErrors: ErrorTenantResult[] = [];
  const processedSet = new Set<string>();
  for (const hid of baseSet) {
    if (!microgridTenantIdSet.has(hid)) {
      unknownTenantErrors.push({
        kind: "error",
        tenantId: hid,
        tenantName: hid,
        error: `Tenant ${hid} is not in this microgrid.`,
        code: "unknown_tenant",
      });
      continue;
    }
    processedSet.add(hid);
  }

  // ── 5. Fetch prior line items for this period (UPSERT preserve + previous*)
  // We need:
  //   - existing line items in THIS period (for previousTotalAmount /
  //     previousPaymentStatus / Q5 currently_manual detection)
  //   - prior-period end_kwh per device for start_kwh derivation
  //
  // Every page (readAllPages): a bill missing from a truncated read would
  // look like "no bill", and a run would not keep it if manual, nor leave
  // it if paid, invoiced or refunded, and would insert over it. A read
  // that cannot be completed stops the run, in every mode.
  const existingItemsRaw = await readAllPages<PriorItem>((after) =>
    pageAfter(
      supabase
        .from("billing_line_items")
        .select(
          // start_kwh, usage_kwh, tier_breakdown, entered_by_user_id and
          // manual_reason are read for sameBill and expectedFromPrior. The
          // audit row's previous_snapshot is built by the write function
          // from the bill as it stands under its lock (20261124170000).
          "id, tenant_id, total_amount, payment_status, reading_source, end_kwh, device_id, start_kwh, usage_kwh, tier_breakdown, entered_by_user_id, manual_reason, invoice_number",
          { count: "exact" },
        )
        .eq("billing_period_id", periodId),
      after,
    ),
  );
  if (existingItemsRaw === null) return unreadable("billing_bills_unreadable");
  const existingByTenant = new Map<string, PriorItem>();
  for (const r of existingItemsRaw) {
    existingByTenant.set(r.tenant_id, r);
  }

  // A first bill from readings for a tenant who already has one writes
  // nothing: that bill is changed by regenerating it. This read of the
  // period's bills is the last before the insert below, and the manual path
  // reads no meter in between (RunGenerationParams.newBillOnly).
  if (newBillOnly && newBillTenant !== undefined && processedSet.has(newBillTenant) && existingByTenant.has(newBillTenant)) {
    return {
      results: [
        {
          kind: "error",
          tenantId: newBillTenant,
          tenantName: tenantNames.get(newBillTenant) ?? newBillTenant,
          error: BILL_FROM_READINGS_COPY.hasBill,
          code: "bill_exists",
        },
      ],
    };
  }

  // Q5: a currently-manual row the request neither re-enters nor reverts
  // stays as it is. Decided here so those tenants are also left out of
  // the prior-reading and metering lookups below.
  const isGuardedManual = (hid: string): boolean =>
    !manualByTenant.has(hid) &&
    existingByTenant.get(hid)?.reading_source === "manual" &&
    !revertToEdgeSet.has(hid);

  // A guarded whole-period run leaves an invoiced, paid or refunded bill as
  // it is, and does not read its meter: the code it reports, or null.
  const leftAs = (hid: string): "invoiced" | "paid" | "refunded" | null => {
    if (!guardExistingBills) return null;
    const prior = existingByTenant.get(hid);
    if (!prior) return null;
    if (prior.invoice_number !== null && prior.invoice_number !== undefined) return "invoiced";
    if (prior.payment_status === "refunded") return "refunded";
    if (prior.payment_status === "paid") return "paid";
    return null;
  };

  // Prior-period device → last end_kwh (start_kwh derivation).
  const deviceIdsForLookup: string[] = [];
  for (const hid of processedSet) {
    if (manualByTenant.has(hid)) continue; // start/end come from override
    if (isGuardedManual(hid)) continue;
    if (leftAs(hid)) continue;
    const dev = tenantToDevice.get(hid);
    if (dev) deviceIdsForLookup.push(dev.deviceId);
  }
  // Every page of both reads (readAllPages), and a read that cannot be
  // completed stops the run: a missing prior reading would start a meter's
  // bill at no reading, or at an older one. The readings are read in slices
  // of the period and device lists (chunked, IN_LIST_CHUNK in
  // ./surface/pages.ts), since both lists grow with the microgrid and travel
  // in the read's URL; the periods latest first, and only the devices not
  // yet found, so a device's reading comes from the first slice that holds
  // one, which holds its latest.
  const priorEndKwhMap = new Map<string, number>();
  if (deviceIdsForLookup.length > 0) {
    const priorPeriods = await readAllPages<{ id: string; end_date: string }>((after) =>
      pageAfter(
        supabase
          .from("billing_periods")
          .select("id, end_date", { count: "exact" })
          .eq("microgrid_id", billingPeriod.microgrid_id)
          .lte("end_date", billingPeriod.start_date)
          .neq("id", billingPeriod.id),
        after,
      ),
    );
    if (priorPeriods === null) return unreadable("billing_readings_unreadable");
    // Latest first; read in pages by id, so ordered here.
    priorPeriods.sort((a, b) => (a.end_date < b.end_date ? 1 : a.end_date > b.end_date ? -1 : 0));
    const periodOrder = new Map(priorPeriods.map((p, i) => [p.id, i]));
    for (const periodIds of chunked(priorPeriods.map((p) => p.id))) {
      const unfound = deviceIdsForLookup.filter((id) => !priorEndKwhMap.has(id));
      if (unfound.length === 0) break;
      const found: { id: string; device_id: string | null; end_kwh: number | string | null; billing_period_id: string }[] = [];
      for (const deviceIds of chunked(unfound)) {
        const items = await readAllPages<(typeof found)[number]>((after) =>
          pageAfter(
            supabase
              .from("billing_line_items")
              .select("id, device_id, end_kwh, billing_period_id", { count: "exact" })
              .in("billing_period_id", periodIds)
              .in("device_id", deviceIds)
              .not("end_kwh", "is", null),
            after,
          ),
        );
        if (items === null) return unreadable("billing_readings_unreadable");
        found.push(...items);
      }
      found.sort(
        (a, b) =>
          (periodOrder.get(a.billing_period_id) ?? Infinity) -
          (periodOrder.get(b.billing_period_id) ?? Infinity)
      );
      for (const item of found) {
        if (item.device_id && !priorEndKwhMap.has(item.device_id)) {
          priorEndKwhMap.set(item.device_id, Number(item.end_kwh));
        }
      }
    }
  }

  // ── 6. Resolve metering readings — only when at least one tenant needs them
  const tenantsNeedingMetering: string[] = [];
  for (const hid of processedSet) {
    if (manualByTenant.has(hid)) continue;
    if (isGuardedManual(hid)) continue;
    if (leftAs(hid)) continue;
    const dev = tenantToDevice.get(hid);
    if (dev) tenantsNeedingMetering.push(hid);
  }

  let usageMap = new Map<string, number | null>();
  if (tenantsNeedingMetering.length > 0) {
    if (!params.meteringProvider) {
      return {
        kind: "fatal",
        status: 503,
        body: {
          error: "No metering provider was supplied for this billing request",
          code: "METERING_CONFIGURATION",
        },
      };
    }

    const deviceConfigs: DeviceConfig[] = tenantsNeedingMetering
      .map((hid) => tenantToDevice.get(hid))
      .filter((d): d is ResolvedDevice => Boolean(d))
      .map((d) => ({
        id: d.deviceId,
        edgeOpenemsId: d.edgeOpenemsId,
        componentId: d.componentId,
      }));
    try {
      // #355: the window's timezone is the PERIOD's stamped value
      // (`billing_periods.timezone`, written once by the BEFORE INSERT
      // trigger from #354) — never `microgrids.timezone`, which the
      // operator can change later. Regenerating a closed period after a
      // microgrid timezone change must reproduce the identical window and
      // therefore byte-identical line items; if the stamp trigger ever
      // starts re-stamping on UPDATE, revisit this guarantee.
      const readings = await params.meteringProvider.getReadings({
        microgridId: billingPeriod.microgrid_id,
        devices: deviceConfigs,
        startDate: billingPeriod.start_date,
        endDate: billingPeriod.end_date,
        timezone: billingPeriod.timezone,
        ...(params.allowUsageOnlyReadings ? { requireCompletePeriod: true } : {}),
      });
      usageMap = new Map(readings.map((reading) => [reading.deviceId, reading.usageKwh]));
    } catch (err) {
      if (err instanceof MeteringError) {
        return {
          kind: "fatal",
          status: err.statusCode,
          body: { error: err.message, code: err.code },
        };
      }
      throw err;
    }
  }

  // ── 6b. A guarded run reads the period's status again before writing ─────
  // Reading the meters can take seconds. Every write below checks the
  // period's status again under its lock (fn_regenerate_bill_with_audit,
  // fn_record_first_line_item_with_audit), so this read only refuses the run
  // early, with nothing written, when the period closed meanwhile, instead
  // of refusing each tenant's write. A first bill from readings reads no
  // meter, but pins the tariff and reads the tenants and bills since its
  // first check, so it reads the status again here too (newBillOnly).
  if (guardExistingBills || newBillOnly) {
    const { data: now, error: nowError } = await supabase
      .from("billing_periods")
      .select("status")
      .eq("id", periodId)
      .maybeSingle<{ status: string }>();
    if (nowError) return unreadable("billing_period_unreadable");
    if (!now) return { kind: "fatal", status: 404, body: { error: "Billing period not found" } };
    if (now.status !== "draft") return periodClosed();
  }

  // ── 7. Per-tenant processing loop ──────────────────────────────────────
  const results: TenantResult[] = [...unknownTenantErrors];

  for (const hid of processedSet) {
    const tenantName = tenantNames.get(hid) ?? hid;
    const prior = existingByTenant.get(hid) ?? null;
    const dev = tenantToDevice.get(hid);
    const manual = manualByTenant.get(hid);
    const assignmentError = tenantAssignmentErrors.get(hid);

    // Q5: a manual row with no new manual reading and no explicit revert.
    // `processedSet` only holds ids from `tenantIds` or `manualReadings`
    // when `tenantIds` is given, so a guarded tenant there was named.
    if (isGuardedManual(hid)) {
      if (tenantIdsParam === undefined) {
        results.push({
          kind: "kept",
          tenantId: hid,
          tenantName,
          readingSource: "manual",
        });
        continue;
      }
      results.push({
        kind: "error",
        tenantId: hid,
        tenantName,
        error:
          "Currently set to manual entry — use per-row regenerate to change.",
        code: "currently_manual",
      });
      continue;
    }

    // Left as it is by a guarded whole-period run (REGENERATE_REFUSAL_COPY
    // says why), after manual rows, which that run keeps whatever their status.
    const left = leftAs(hid);
    if (left) {
      results.push({ kind: "error", tenantId: hid, tenantName, error: REGENERATE_REFUSAL_COPY[left], code: left });
      continue;
    }

    // The bill this write must still find: the caller's, on a per-bill
    // regeneration, or on a guarded whole-period run, this tenant's bill as
    // read above. None for a tenant with no bill, whose bill is inserted.
    const expected: ExpectedBill | undefined =
      expectedBill ?? (guardExistingBills && prior && mode === "write" ? expectedFromPrior(prior) : undefined);

    // Resolve start_kwh / end_kwh / usage_kwh / reading_source / device_id.
    let startKwh: number | null;
    let endKwh: number | null;
    let usageKwh: number;
    let readingSource: ReadingSource;
    let deviceId: string | null;
    let manualReason: string | null = null;

    if (manual) {
      // Manual override path. AC3: usage_kwh is server-derived.
      // Defensive: re-validate end >= start (route Zod schema also catches).
      if (!Number.isFinite(manual.startKwh) || manual.startKwh < 0) {
        results.push({
          kind: "error",
          tenantId: hid,
          tenantName,
          error: "startKwh must be a non-negative finite number.",
          code: "invalid_manual_reading",
        });
        continue;
      }
      if (!Number.isFinite(manual.endKwh) || manual.endKwh < 0) {
        results.push({
          kind: "error",
          tenantId: hid,
          tenantName,
          error: "endKwh must be a non-negative finite number.",
          code: "invalid_manual_reading",
        });
        continue;
      }
      if (manual.endKwh < manual.startKwh) {
        results.push({
          kind: "error",
          tenantId: hid,
          tenantName,
          error: "endKwh must be greater than or equal to startKwh.",
          code: "invalid_manual_reading",
        });
        continue;
      }
      startKwh = manual.startKwh;
      endKwh = manual.endKwh;
      usageKwh = endKwh - startKwh;
      readingSource = "manual";
      // Manual rows can have a device_id (BC2/BC3 toggle metered → manual)
      // OR none (un-metered tenant). Preserve the metered link if there
      // is one — informational only; the manual reading is authoritative.
      deviceId = dev?.deviceId ?? tenantEndDevice.get(hid) ?? null;
      manualReason = manual.reason ?? null;
    } else if (assignmentError) {
      results.push({
        kind: "error",
        tenantId: hid,
        tenantName,
        error: assignmentError,
        code: "meter_assignment_continuity",
      });
      continue;
    } else if (dev) {
      // Metered path — the injected provider supplied the reading above.
      const u = usageMap.get(dev.deviceId);
      if (u === null || u === undefined) {
        results.push({
          kind: "error",
          tenantId: hid,
          tenantName,
          error: "No meter reading data available",
          code: "no_meter_reading",
        });
        continue;
      }
      usageKwh = u;

      // #339. Three sources, in order, and NO zero default.
      //
      //   1. prior MGM end_kwh for this device — the running tally
      //   2. an operator seed — the meter was billed before it was connected
      //   3. neither → refuse; see needs_seed_reading
      //
      // The old `?? 0` converted "I have no record" into "the meter read
      // zero". Those are different claims and the second one gets printed on
      // an invoice the customer can check against the dial.
      //
      // A tenant-keyed fallback (the tenant's last end_kwh from rows
      // written before the device existed) is deliberately NOT a fourth
      // source. It is correct when a meter was connected and silently wrong
      // when a meter was replaced, and the two are indistinguishable in the
      // data — it would turn a visibly wrong 0 into a plausible wrong number.
      const priorEnd = priorEndKwhMap.get(dev.deviceId);
      const seed = seedByDevice.get(dev.deviceId);
      if (priorEnd != null) {
        startKwh = priorEnd;
      } else if (seed) {
        startKwh = seed.startKwh;
      } else if (params.allowUsageOnlyReadings) {
        // OpenEMS has a per-device total for this period, but no trustworthy
        // absolute register at its start. Bill the measured usage and leave
        // both dial fields unknown; zero would falsely claim a physical read.
        startKwh = null;
      } else {
        results.push({
          kind: "error",
          tenantId: hid,
          tenantName,
          error:
            "A trusted starting register is unavailable for this meter and billing period.",
          code: "needs_seed_reading",
        });
        continue;
      }

      endKwh = startKwh === null ? null : startKwh + usageKwh;
      readingSource = "edge";
      deviceId = dev.deviceId;
    } else {
      // Un-metered tenant with no manual override: skip and report with
      // 'unmetered_no_manual'. This holds for BOTH the explicit dashboard
      // path (tenantIds includes this id) AND the implicit pull-mode path
      // (tenantIds === undefined) — #293.
      //
      // Pull-mode is an unattended cron. Writing a silent zeroed placeholder
      // row (start_kwh=0, end_kwh=0, usage_kwh=0) there mis-bills an un-metered
      // tenant as service-charge-only with no human in the loop; the only
      // signal is the response payload. Per Alejandro's decision (2026-07-01,
      // #293): no manual reading AND no OpenEMS data → do NOT bill; skip the
      // tenant and report it so the cron/caller sees it. The dashboard path
      // already emitted this same error; the two paths now agree.
      results.push({
        kind: "error",
        tenantId: hid,
        tenantName,
        error: "Tenant has no meter and no manual reading was supplied.",
        code: "unmetered_no_manual",
      });
      continue;
    }

    // Compute tier breakdown + total.
    const calc = calculateTieredCost(
      usageKwh,
      rateSchedule.tiers as TierConfig[],
      rateSchedule.service_charge,
      rateSchedule.tax_rate
    );

    // #227: round the reading-side numerics. `calc.tierBreakdown` and
    // `calc.totalAmount` are already rounded by calculateTieredCost.
    // Rounding here closes IEEE-754 dust from arithmetic like
    // `261.92 - 83.570 === 178.35000000000002` before the values land
    // in storage or in the preview payload.
    const startKwhRounded = startKwh === null ? null : roundKwh(startKwh);
    const endKwhRounded = endKwh === null ? null : roundKwh(endKwh);
    const usageKwhRounded = roundKwh(usageKwh);
    const previousTotalAmount =
      prior ? roundAmount(Number(prior.total_amount)) : null;

    if (mode === "preview") {
      results.push({
        kind: "preview",
        tenantId: hid,
        tenantName,
        startKwh: startKwhRounded,
        endKwh: endKwhRounded,
        usageKwh: usageKwhRounded,
        tierBreakdown: calc.tierBreakdown,
        totalAmount: calc.totalAmount,
        previousUsageKwh:
          prior && prior.usage_kwh !== null
            ? roundKwh(Number(prior.usage_kwh))
            : null,
        previousTotalAmount,
        previousPaymentStatus: prior?.payment_status ?? null,
      });
      continue;
    }

    // mode === 'write'. A per-bill regeneration whose figures are the ones
    // the bill already has writes nothing, so a repeated submit adds no
    // second audit row. Compared as fn_record_line_item_with_audit would
    // store them (kWh to 3 places, amounts to whole units, which
    // calculateTieredCost has already rounded).
    const enteredBy = readingSource === "manual" ? actorUserId : null;
    if (
      expected &&
      prior &&
      sameBill(prior, {
        deviceId,
        usageKwh: usageKwhRounded,
        startKwh: startKwhRounded,
        endKwh: endKwhRounded,
        tierBreakdown: calc.tierBreakdown,
        totalAmount: roundAmount(calc.totalAmount),
        readingSource,
        enteredBy,
        manualReason: readingSource === "manual" ? manualReason : null,
      })
    ) {
      results.push({
        kind: "unchanged",
        tenantId: hid,
        tenantName,
        lineItemId: prior.id,
        totalAmount: roundAmount(Number(prior.total_amount)),
      });
      continue;
    }

    // SIGNATURE NOTE: this RPC's signature was widened in #250 (actor_kind,
    // actor_ref). PostgREST overload-resolution will reject DROP-less signature
    // changes with PGRST203. Any future param addition requires
    // `DROP FUNCTION IF EXISTS` in the migration BEFORE `CREATE OR REPLACE`.
    // See PR #209 / #250 for prior lessons. fn_regenerate_bill_with_audit
    // takes fn_record_line_item_with_audit's arguments plus `_expected` and
    // passes them on, and fn_record_first_line_item_with_audit takes the same
    // arguments, so a parameter added to one is added to the other two in
    // the same migration.
    // Without a bill to expect, the write is a tenant's first bill: step 0
    // refused a write with no guard, a per-bill regeneration always has one
    // (expectedBill), a guarded whole-period run expects every bill it read,
    // and a first bill from readings stopped above if the tenant had one. It
    // is inserted only while the tenant still has none and the period is
    // still a draft, under the period's lock
    // (fn_record_first_line_item_with_audit).
    const recordArgs = {
      _billing_period_id: periodId,
      _tenant_id: hid,
      _device_id: deviceId,
      _usage_kwh: usageKwhRounded,
      _start_kwh: startKwhRounded,
      _end_kwh: endKwhRounded,
      _tier_breakdown: calc.tierBreakdown,
      _total_amount: calc.totalAmount,
      _reading_source: readingSource,
      _entered_by_user_id: actorUserId,
      _manual_reason: manualReason,
      _actor_user_id: actorUserId,
      // Built by the function from the bill it writes and the one it
      // replaces (20261124170000); a signed-in caller's details may carry
      // no key of their own.
      _audit_details: null,
      _rate_schedule_id: rateScheduleId,
      _actor_kind: actorKind,
      _actor_ref: actorRef,
    };
    const { data: rpcRow, error: rpcErr } = expected
      ? await supabase.rpc("fn_regenerate_bill_with_audit", {
          ...recordArgs,
          _expected: {
            line_item_id: expected.lineItemId,
            payment_status: expected.paymentStatus,
            total_amount: expected.totalAmount,
            usage_kwh: expected.usageKwh,
            start_kwh: expected.startKwh,
            end_kwh: expected.endKwh,
            reading_source: expected.readingSource,
            device_id: expected.deviceId,
            tier_breakdown: expected.tierBreakdown,
            entered_by_user_id: expected.enteredByUserId,
            manual_reason: expected.manualReason,
          },
        })
      : await supabase.rpc("fn_record_first_line_item_with_audit", recordArgs);

    const refused = rpcErr ? (expected ? expectedBillRefusal(rpcErr) : firstBillRefusal(rpcErr, newBillOnly === true)) : null;
    if (refused) {
      results.push({ kind: "error", tenantId: hid, tenantName, ...refused });
      continue;
    }

    if (rpcErr || !rpcRow) {
      results.push({
        kind: "error",
        tenantId: hid,
        tenantName,
        error: `Failed to write line item: ${rpcErr?.message ?? "unknown"}`,
        code: rpcErr?.code === "23514" && rpcErr.message.includes("tariff changed")
          ? "tariff_changed"
          : "line_item_write_failed",
      });
      continue;
    }

    // Supabase RPC returning a composite row may surface as a single object
    // (PostgREST returns the row directly when the function returns a single
    // composite). Defensive coerce in case it arrives wrapped in an array.
    const writtenRowRaw = Array.isArray(rpcRow) ? rpcRow[0] : rpcRow;
    const writtenRow = writtenRowRaw as unknown as BillingLineItem;

    results.push({
      kind: "written",
      tenantId: hid,
      tenantName,
      lineItem: writtenRow,
      previousTotalAmount,
      previousPaymentStatus: prior?.payment_status ?? null,
      previousReadingSource: prior?.reading_source ?? null,
    });
  }

  // A guarded run says which tenants it did not bill already had a bill,
  // which stays as it was read (ErrorTenantResult.hadBill).
  if (guardExistingBills) {
    for (const r of results) {
      if (r.kind === "error" && existingByTenant.has(r.tenantId)) r.hadBill = true;
    }
  }

  return { results };
}

// ── Per-bill regeneration helpers ───────────────────────────────────────────

/**
 * fn_regenerate_bill_with_audit's refusals (migration
 * 20261119090000_regenerate_bill_expected_state.sql), by the token its
 * message starts with, as fixed copy. Anything else is an ordinary write
 * failure.
 */
const EXPECTED_BILL_REFUSALS: Record<string, { code: GenerationErrorCode; error: string }> = {
  billing_period_closed: { code: "period_closed", error: REGENERATE_REFUSAL_COPY.closed },
  billing_line_item_invoiced: { code: "invoiced", error: REGENERATE_REFUSAL_COPY.invoiced },
  billing_line_item_changed: { code: "bill_changed", error: REGENERATE_REFUSAL_COPY.changed },
};

function expectedBillRefusal(err: { code?: string; message?: string }): { code: GenerationErrorCode; error: string } | null {
  if (err.code !== "23514") return null;
  const token = (err.message ?? "").split(":")[0].trim();
  return EXPECTED_BILL_REFUSALS[token] ?? null;
}

/**
 * fn_record_first_line_item_with_audit's refusals (migration
 * 20261120130100_record_first_line_item.sql, last issued by
 * 20261124170000), by the token its message starts with, in the copy of the
 * action that ran: a first bill from readings (`newBillOnly`) or a
 * whole-period run from meter data. billing_period_not_found is its one
 * P0002, raised when the period is gone (deleted after the run read it);
 * the others are 23514. Its tariff refusal keeps the upsert's text and is
 * mapped to `tariff_changed` with the other write failures below; anything
 * else is an ordinary write failure.
 */
function firstBillRefusal(err: { code?: string; message?: string }, newBillOnly: boolean): { code: GenerationErrorCode; error: string } | null {
  const token = (err.message ?? "").split(":")[0].trim();
  if (err.code === "P0002" && token === "billing_period_not_found") {
    return { code: "period_not_found", error: newBillOnly ? BILL_FROM_READINGS_COPY.periodNotFound : GENERATE_FROM_METERS_COPY.periodNotFound };
  }
  if (err.code !== "23514") return null;
  if (token === "billing_period_closed") {
    return { code: "period_closed", error: newBillOnly ? BILL_FROM_READINGS_COPY.closed : GENERATE_FROM_METERS_COPY.closed };
  }
  if (token === "billing_line_item_exists") return { code: "bill_exists", error: BILL_FROM_READINGS_COPY.hasBill };
  return null;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * A bill as a guarded whole-period run read it, as the expectedBill of its
 * rewrite: every value fn_regenerate_bill_with_audit compares, as stored.
 */
function expectedFromPrior(prior: PriorItem): ExpectedBill {
  return {
    lineItemId: prior.id,
    tenantId: prior.tenant_id,
    paymentStatus: prior.payment_status,
    totalAmount: Number(prior.total_amount),
    usageKwh: numOrNull(prior.usage_kwh),
    startKwh: numOrNull(prior.start_kwh),
    endKwh: numOrNull(prior.end_kwh),
    readingSource: prior.reading_source ?? null,
    deviceId: prior.device_id ?? null,
    tierBreakdown: prior.tier_breakdown,
    enteredByUserId: prior.entered_by_user_id ?? null,
    manualReason: prior.manual_reason ?? null,
  };
}

/** Whether a bill already holds the figures a regeneration would write. */
function sameBill(
  prior: PriorItem,
  next: {
    deviceId: string | null;
    usageKwh: number;
    startKwh: number | null;
    endKwh: number | null;
    tierBreakdown: TierBreakdown[];
    totalAmount: number;
    readingSource: ReadingSource;
    enteredBy: string | null;
    manualReason: string | null;
  },
): boolean {
  const tiers = Array.isArray(prior.tier_breakdown) ? (prior.tier_breakdown as { label?: unknown; kwh?: unknown; amount?: unknown }[]) : null;
  return (
    prior.reading_source === next.readingSource &&
    (prior.device_id ?? null) === next.deviceId &&
    numOrNull(prior.usage_kwh) === next.usageKwh &&
    numOrNull(prior.start_kwh) === next.startKwh &&
    numOrNull(prior.end_kwh) === next.endKwh &&
    Number(prior.total_amount) === next.totalAmount &&
    (prior.entered_by_user_id ?? null) === next.enteredBy &&
    (prior.manual_reason ?? null) === next.manualReason &&
    tiers !== null &&
    tiers.length === next.tierBreakdown.length &&
    tiers.every(
      (t, n) =>
        t?.label === next.tierBreakdown[n].label &&
        Number(t?.kwh) === roundKwh(next.tierBreakdown[n].kwh) &&
        Number(t?.amount) === roundAmount(next.tierBreakdown[n].amount),
    )
  );
}
