import "server-only";

/**
 * generate.ts — shared billing-line-item generation engine (#173, BC1).
 *
 * This module owns the per-tenant compute + (optionally) write loop that
 * used to live inline in `src/app/api/billing/generate/route.ts`. After BC1
 * three callers share it:
 *
 *   1. `POST /api/billing/generate` — bulk OR selective (mode='write').
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
 *   2. `POST /api/billing/regenerate-preview` — same body without
 *      `seedReadings` (`PreviewBillsBody`), mode='preview'.
 *      Returns the in-memory calc + previousTotalAmount/previousPaymentStatus
 *      from the prior line item; writes nothing.
 *
 *   3. `PATCH /api/billing-line-items/[lineItemId]/usage` — single-cell manual
 *      edit. Internally resolves `tenantIds: [<resolved>]` +
 *      `manualReadings: [<resolved>]` and calls with mode='write'.
 *
 * ── Write semantics (mode='write') ──────────────────────────────────────────
 *
 * Every tenant processed goes through `fn_record_line_item_with_audit`
 * (00029), which UPSERTs by (billing_period_id, tenant_id) — preserving
 * payment_status / paid_at / paid_by_user_id / pesapal_order_id / payment_*
 * columns on UPDATE, so a regenerate doesn't clobber a paid row's audit
 * fields and doesn't cascade away its payment_events history. The function
 * also writes one row to billing_audit_log per call (in the same transaction).
 *
 * The legacy bulk-only delete-then-insert path is REMOVED — this is the
 * critical AC3 change. UPSERT-preserve is the only write path.
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
 * With service-role callers (via `/api/v1/*`), RLS does NOT backstop
 * the cross-microgrid check above — it is the SOLE defense against
 * cross-microgrid tenant submission. Do NOT delete on the assumption
 * that RLS will catch it; RLS only fires for user-bound clients. See PR
 * #246 review + #250 ticket body for the original reasoning.
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
import type { LineItemRegeneratedDetails } from "@/lib/types/billing-audit";
import { REGENERATE_REFUSAL_COPY } from "./schemas";

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
 * The route checks only that startKwh does not exceed dialReadingKwh
 * (GenerateBillsBody); it does not recompute startKwh from the inputs, so
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
   * A per-bill regeneration (`expectedBill`) found the bill no longer as the
   * caller read it: its period closed, it was invoiced, or its payment
   * status or figures changed (fn_regenerate_bill_with_audit). Nothing was
   * written.
   */
  | "period_closed"
  | "invoiced"
  | "bill_changed"
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
   *  For non-human callers (customerapp via `/api/v1/*`, future
   *  cron jobs, etc.) pass `null` and set `actorKind` + `actorRef`. The
   *  DB CHECK on `billing_audit_log` enforces the (kind, user_id, ref)
   *  shape (see migration 00041 / #250). */
  actorUserId: string | null;
  /** Defaults to `'human'` for backwards compatibility with all existing
   *  in-app callers (the dashboard routes). `'customerapp'` is set by
   *  `/api/v1/*` routes; `'system'` by webhook ingestors.
   *  See migration 00041 (#250). */
  actorKind?: "human" | "customerapp" | "system";
  /** Opaque caller-supplied identifier — token name for customerapp,
   *  source key (e.g. `'pesapal_ipn'`) for system. Required by DB CHECK
   *  whenever `actorKind != 'human'`. */
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
   * ones the bill already has (`kind: 'unchanged'`). Unset, as on POST
   * /api/billing/generate, nothing here applies.
   */
  expectedBill?: ExpectedBill;
};

/** The bill a per-bill regeneration read (RunGenerationParams.expectedBill). */
export type ExpectedBill = {
  lineItemId: string;
  tenantId: string;
  paymentStatus: BillingLineItemPaymentStatus;
  totalAmount: number;
  usageKwh: number | null;
  startKwh: number | null;
  endKwh: number | null;
  readingSource: ReadingSource | null;
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
  // ── New for #218 (previous-snapshot capture) ─────────────────────────────
  // Required to build `auditDetails.previous_snapshot` for the
  // `line_item_regenerated` event. The SELECT at :362 must read these too —
  // the explicit `as unknown as PriorItem[]` cast at :366 suppresses
  // PostgREST's inferred shape, so widening this type without widening the
  // SELECT would compile but resolve `undefined` at runtime.
  start_kwh: number | null;
  usage_kwh: number | null;
  /** JSONB — shape is `TierBreakdown[]` in the live row but we keep it
   *  `unknown` here to match the audit-snapshot contract (round-trip,
   *  no validation). */
  tier_breakdown: unknown;
  entered_by_user_id: string | null;
  entered_at: string | null;
  manual_reason: string | null;
};

// ── Implementation ──────────────────────────────────────────────────────────

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

  // ── 0a. A per-bill regeneration names its one tenant and nothing else ──────
  const expectedBill = mode === "write" ? params.expectedBill : undefined;
  if (
    expectedBill &&
    (tenantIdsParam?.length !== 1 ||
      tenantIdsParam[0] !== expectedBill.tenantId ||
      manualReadingsParam.some((m) => m.tenantId !== expectedBill.tenantId) ||
      (params.seedReadings ?? []).length > 0)
  ) {
    return {
      kind: "fatal",
      status: 400,
      body: { error: "A per-bill regeneration names its bill's one tenant.", code: "expected_bill_mismatch" },
    };
  }

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

  // Q4=B: closed-period regenerate IS allowed via /api/billing/generate (the
  // legacy reject removed in this ticket). PATCH /usage retains its own
  // `period_closed` reject upstream — see the route handler.

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
  const { data: tenantsRaw, error: tenantsError } = await supabase
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
    `
    )
    .eq("microgrid_id", billingPeriod.microgrid_id)
    .eq("tenant_devices.role", "primary_consumption_meter");

  if (tenantsError) {
    return {
      kind: "fatal",
      status: 500,
      body: {
        error: `Error fetching tenants: ${tenantsError.message}`,
      },
    };
  }

  const tenantsAll = (tenantsRaw ?? []) as unknown as TenantRow[];
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
      const overlappingAssignments = primaryAssignments.filter(
        (assignment) =>
          Boolean(assignment.effective_from) &&
          assignment.effective_from! <= billingPeriod.end_date &&
          (assignment.effective_to === null ||
            assignment.effective_to === undefined ||
            assignment.effective_to > billingPeriod.start_date)
      );
      const coveringAssignments = overlappingAssignments.filter(
        (assignment) =>
          assignment.effective_from! <= billingPeriod.start_date &&
          (assignment.effective_to === null ||
            assignment.effective_to === undefined ||
            assignment.effective_to > billingPeriod.end_date)
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
  const { data: existingItemsRaw } = await supabase
    .from("billing_line_items")
    .select(
      // The trailing fields (start_kwh, usage_kwh, tier_breakdown,
      // entered_by_user_id, entered_at, manual_reason) are read for #218's
      // `previous_snapshot` audit-details capture — the RPC overwrites them
      // on UPSERT-UPDATE, so we must read them BEFORE calling the RPC.
      "id, tenant_id, total_amount, payment_status, reading_source, end_kwh, device_id, start_kwh, usage_kwh, tier_breakdown, entered_by_user_id, entered_at, manual_reason"
    )
    .eq("billing_period_id", periodId);
  const existingByTenant = new Map<string, PriorItem>();
  for (const r of (existingItemsRaw ?? []) as unknown as PriorItem[]) {
    existingByTenant.set(r.tenant_id, r);
  }

  // Q5: a currently-manual row the request neither re-enters nor reverts
  // stays as it is. Decided here so those tenants are also left out of
  // the prior-reading and metering lookups below.
  const isGuardedManual = (hid: string): boolean =>
    !manualByTenant.has(hid) &&
    existingByTenant.get(hid)?.reading_source === "manual" &&
    !revertToEdgeSet.has(hid);

  // Prior-period device → last end_kwh (start_kwh derivation).
  const deviceIdsForLookup: string[] = [];
  for (const hid of processedSet) {
    if (manualByTenant.has(hid)) continue; // start/end come from override
    if (isGuardedManual(hid)) continue;
    const dev = tenantToDevice.get(hid);
    if (dev) deviceIdsForLookup.push(dev.deviceId);
  }
  const priorEndKwhMap = new Map<string, number>();
  if (deviceIdsForLookup.length > 0) {
    const { data: priorPeriods } = await supabase
      .from("billing_periods")
      .select("id")
      .eq("microgrid_id", billingPeriod.microgrid_id)
      .lte("end_date", billingPeriod.start_date)
      .neq("id", billingPeriod.id)
      .order("end_date", { ascending: false });
    if (priorPeriods && priorPeriods.length > 0) {
      const priorPeriodIds = priorPeriods.map((p) => p.id);
      const { data: priorItems } = await supabase
        .from("billing_line_items")
        .select("device_id, end_kwh, billing_period_id")
        .in("billing_period_id", priorPeriodIds)
        .in("device_id", deviceIdsForLookup)
        .not("end_kwh", "is", null);
      if (priorItems) {
        const periodOrder = new Map(priorPeriodIds.map((id, i) => [id, i]));
        priorItems.sort(
          (a, b) =>
            (periodOrder.get(a.billing_period_id) ?? 999) -
            (periodOrder.get(b.billing_period_id) ?? 999)
        );
        for (const item of priorItems) {
          if (item.device_id && !priorEndKwhMap.has(item.device_id)) {
            priorEndKwhMap.set(item.device_id, Number(item.end_kwh));
          }
        }
      }
    }
  }

  // ── 6. Resolve metering readings — only when at least one tenant needs them
  const tenantsNeedingMetering: string[] = [];
  for (const hid of processedSet) {
    if (manualByTenant.has(hid)) continue;
    if (isGuardedManual(hid)) continue;
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
      expectedBill &&
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

    const auditDetails: LineItemRegeneratedDetails = {
      tenant_name: tenantName,
      previous_total_amount: previousTotalAmount,
      new_total_amount: calc.totalAmount,
      previous_reading_source: prior?.reading_source ?? null,
      new_reading_source: readingSource,
      ...(readingSource === "manual" && manualReason
        ? { manual_reason: manualReason }
        : {}),
      // #218: capture the reading-side snapshot of the row immediately BEFORE
      // this regeneration overwrites it. Present only on UPDATE (when prior
      // exists); absent on fresh INSERT. Numerics use `Number(x)`-or-null
      // coercion to match the existing previous_total_amount precision
      // pattern above. Note: `previous_snapshot.manual_reason` is the
      // PREVIOUS reason, distinct from the top-level `manual_reason` (NEW).
      ...(prior
        ? {
            previous_snapshot: {
              start_kwh:
                prior.start_kwh != null ? Number(prior.start_kwh) : null,
              end_kwh: prior.end_kwh != null ? Number(prior.end_kwh) : null,
              usage_kwh:
                prior.usage_kwh != null ? Number(prior.usage_kwh) : null,
              tier_breakdown: prior.tier_breakdown,
              device_id: prior.device_id,
              entered_by_user_id: prior.entered_by_user_id,
              entered_at: prior.entered_at,
              manual_reason: prior.manual_reason,
            },
          }
        : {}),
    };

    // SIGNATURE NOTE: this RPC's signature was widened in #250 (actor_kind,
    // actor_ref). PostgREST overload-resolution will reject DROP-less signature
    // changes with PGRST203. Any future param addition requires
    // `DROP FUNCTION IF EXISTS` in the migration BEFORE `CREATE OR REPLACE`.
    // See PR #209 / #250 for prior lessons. fn_regenerate_bill_with_audit
    // takes the same arguments plus `_expected` and passes them on, so a
    // parameter added to one is added to the other in the same migration.
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
      _audit_details: auditDetails as unknown as Record<string, unknown>,
      _rate_schedule_id: rateScheduleId,
      _actor_kind: actorKind,
      _actor_ref: actorRef,
    };
    const { data: rpcRow, error: rpcErr } = expectedBill
      ? await supabase.rpc("fn_regenerate_bill_with_audit", {
          ...recordArgs,
          _expected: {
            line_item_id: expectedBill.lineItemId,
            payment_status: expectedBill.paymentStatus,
            total_amount: expectedBill.totalAmount,
            usage_kwh: expectedBill.usageKwh,
            start_kwh: expectedBill.startKwh,
            end_kwh: expectedBill.endKwh,
            reading_source: expectedBill.readingSource,
          },
        })
      : await supabase.rpc("fn_record_line_item_with_audit", recordArgs);

    const refused = expectedBill && rpcErr ? expectedBillRefusal(rpcErr) : null;
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

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

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
