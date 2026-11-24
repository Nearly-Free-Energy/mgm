import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateRoute } from "@/lib/runtime/gate";
import { getMgmRuntime } from "@/lib/runtime/root";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import {
  isRunGenerationFatal,
  runGenerationFor,
  type ExpectedBill,
} from "@/lib/billing/generate";
import { LineItemUsageBody, REGENERATE_PAID_ACKNOWLEDGEMENT, USAGE_REFUSAL_COPY } from "@/lib/billing/schemas";
import type { BillingLineItem } from "@/lib/types/domain";
import { parseJsonBody } from "@/lib/validation/parse-body";

/**
 * PATCH /api/billing-line-items/[lineItemId]/usage (#158, rewritten in #173,
 * a per-bill regeneration since #247)
 *
 * Manual usage entry for un-metered (manual-billing) tenants: the period
 * review's billing.record-usage.
 *
 *   Body:  { usage_kwh?: number; end_kwh?: number }   (at least one)
 *          and, for a paid bill,
 *          confirmation: { acknowledged: [REGENERATE_PAID_ACKNOWLEDGEMENT] }:
 *          the acknowledgement billing.record-usage's prepare asks for.
 *          Parsed with `LineItemUsageBody` (`@/lib/billing/schemas`);
 *          unknown keys are refused.
 *   200:   { lineItem: <the bill> }: as written, or as it was when it
 *          already had these figures, in which case nothing was written (no
 *          audit row), so sending a correction twice records it once
 *   400:   invalid body / negative / non-numeric:
 *          { error, field?, code: "invalid_body" }
 *   400:   end_kwh below start_kwh: { error, reason: "invalid_body" }
 *   401:   no session
 *   403:   caller cannot access microgrid
 *   404:   line item not found / RLS-hidden
 *   409:   { error, reason }, nothing written (USAGE_REFUSAL_COPY), in this
 *          order: period_closed (a bill in a closed period), invoiced (a
 *          bill with an invoice number), refunded, device_linked
 *          (line_item.device_id != NULL OR the tenant has a
 *          primary_consumption_meter link in the period),
 *          missing_start_reading
 *   409:   period_closed | invoiced | bill_changed when the bill changed
 *          between this route's read and the write (nothing written)
 *   428:   { error, reason: "paid_acknowledgement_required" } (a paid bill
 *          without the acknowledgement; nothing written)
 *   500:   anything else
 *
 * The correction is a per-bill regeneration from manual readings: the route
 * runs the bill engine for the bill's one tenant with the bill as read here
 * as its `expectedBill`, as POST …/regenerate does, so it is written through
 * fn_regenerate_bill_with_audit. That write refuses, under locks held to
 * commit, unless the period is still a draft and the bill still has no
 * invoice number and the values read here, and writes the bill and one
 * audit row (line_item_regenerated) in one transaction, keeping its payment
 * columns. The route refuses what the regenerate route refuses, and asks
 * for the same acknowledgement on a paid bill (#247, decided by the billing
 * owner on 24 November 2026); if the regenerate route's rules change,
 * revisit these.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The bill as read, with its period: every column the 200 answers with, of
 * which the expectedBill is built. NUMERIC columns can arrive as strings.
 */
type LineItemScope = Omit<BillingLineItem, "total_amount" | "usage_kwh" | "start_kwh" | "end_kwh"> & {
  total_amount: number | string;
  usage_kwh: number | string | null;
  start_kwh: number | string | null;
  end_kwh: number | string | null;
  billing_periods: {
    id: string;
    microgrid_id: string;
    status: string;
    start_date: string;
    end_date: string;
  } | null;
};

const numOrNull = (v: number | string | null): number | null => (v === null ? null : Number(v));

/** A refusal in USAGE_REFUSAL_COPY's words. */
const refused = (key: keyof typeof USAGE_REFUSAL_COPY, reason: string) =>
  NextResponse.json({ error: USAGE_REFUSAL_COPY[key], reason }, { status: 409 });

/** The engine's refusals of a bill that changed after the read, in the route's words. */
const WRITE_REFUSALS = {
  period_closed: "closed",
  invoiced: "invoiced",
  bill_changed: "changed",
} as const satisfies Record<string, keyof typeof USAGE_REFUSAL_COPY>;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> }
): Promise<NextResponse> {
  const { lineItemId } = await params;

  if (!UUID_RE.test(lineItemId)) {
    return NextResponse.json(
      { error: "Invalid line item id — expected UUID.", reason: "bad_request" },
      { status: 400 }
    );
  }

  // The body is checked before the session, as it was before it parsed
  // with a schema: a malformed body answers 400 whoever sends it.
  const body = await parseJsonBody(request, LineItemUsageBody);
  if (!body.ok) return body.response;
  const parsed = body.data;

  const supabase = await createClient();

  // Explicit auth gate (BC1 AC6) — anonymous calls return 401 instead of
  // a confusing 404 / 500-on-RLS.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthorized", reason: "unauthorized" },
      { status: 401 }
    );
  }

  // 1. Resolve line item → period → microgrid, through the person's own
  //    client: a bill RLS hides is a 404.
  const { data: scopedRaw, error: scopeErr } = await supabase
    .from("billing_line_items")
    .select(
      `
      *,
      billing_periods!inner (
        id,
        microgrid_id,
        status,
        start_date,
        end_date
      )
    `
    )
    .eq("id", lineItemId)
    .maybeSingle();

  if (scopeErr) {
    return NextResponse.json(
      {
        error: `Failed to look up line item: ${scopeErr.message}`,
        reason: "unknown_error",
      },
      { status: 500 }
    );
  }
  if (!scopedRaw) {
    return NextResponse.json(
      { error: "Line item not found.", reason: "not_found" },
      { status: 404 }
    );
  }

  const { billing_periods: periodRaw, ...bill } = scopedRaw as unknown as LineItemScope;
  const period = Array.isArray(periodRaw) ? periodRaw[0] : periodRaw;
  if (!period) {
    return NextResponse.json(
      { error: "Line item not found.", reason: "not_found" },
      { status: 404 }
    );
  }

  // 2. Permission gate.
  if (!(await currentUserCanAccessMicrogrid(supabase, period.microgrid_id))) {
    return NextResponse.json(
      {
        error: "You do not have permission to update this line item.",
        reason: "forbidden",
      },
      { status: 403 }
    );
  }

  // 2a. Release 3 (issue #5): usage corrections fail closed while billing is disabled.
  const billingGate = await gateRoute(supabase, {
    plugin: "billing",
    target: { kind: "microgrid", id: period.microgrid_id },
    method: "PATCH",
  });
  if (billingGate) return billingGate;

  // 3. What the regenerate route refuses, in its order (USAGE_REFUSAL_COPY
  //    has why). billing.record-usage's availability and prepare explain the
  //    same refusals in the same order (src/lib/billing/surface/period-review.ts).
  if (period.status !== "draft") return refused("closed", "period_closed");
  if (bill.invoice_number !== null) return refused("invoiced", "invoiced");
  if (bill.payment_status === "refunded") return refused("refunded", "refunded");

  // 4. Reject metered rows. Both signals must be checked: the line item's
  //    own device_id AND any primary_consumption_meter assignment that
  //    overlapped this billing period (a tenant may have a meter but the
  //    line item was inserted pre-link). Historical replacements outside the
  //    period must not block a correction, nor turn `.maybeSingle()` into a
  //    multi-row error.
  if (bill.device_id !== null) return refused("metered", "device_linked");

  const { data: meterLinks, error: linkErr } = await supabase
    .from("tenant_devices")
    .select("device_id, effective_from, effective_to")
    .eq("tenant_id", bill.tenant_id)
    .eq("role", "primary_consumption_meter");

  if (linkErr) {
    return NextResponse.json(
      {
        error: `Failed to verify tenant meter link: ${linkErr.message}`,
        reason: "unknown_error",
      },
      { status: 500 }
    );
  }
  const meterLinkOverlapsPeriod = (meterLinks ?? []).some(
    (link: { effective_from: string; effective_to: string | null }) =>
      link.effective_from <= period.end_date &&
      (link.effective_to === null || link.effective_to > period.start_date)
  );
  if (meterLinkOverlapsPeriod) return refused("metered", "device_linked");

  // 5. Resolve start/end/usage. Same matrix as before:
  //   - both provided → use both verbatim (server-derives usage if it
  //     differs from end - start; the BC1 generate engine always derives,
  //     so we standardize to end_kwh authoritative when both provided)
  //   - only end_kwh   → derive usage_kwh = end_kwh - start_kwh
  //   - only usage_kwh → end_kwh = start_kwh + usage_kwh (so generate
  //     engine sees a consistent {start, end, usage} triple)
  const startKwh = numOrNull(bill.start_kwh);
  if (startKwh === null) return refused("noStart", "missing_start_reading");
  let nextEnd: number;

  if (parsed.usage_kwh !== undefined && parsed.end_kwh !== undefined) {
    // Both provided — prefer end_kwh as authoritative input. The generate
    // engine will derive usage_kwh = end_kwh - start_kwh.
    nextEnd = parsed.end_kwh;
  } else if (parsed.end_kwh !== undefined) {
    nextEnd = parsed.end_kwh;
    if (parsed.end_kwh - startKwh < 0) {
      return NextResponse.json(
        {
          error: "end_kwh must be greater than or equal to start_kwh",
          reason: "invalid_body",
        },
        { status: 400 }
      );
    }
  } else {
    // usage_kwh only — derive end_kwh = start_kwh + usage_kwh.
    nextEnd = startKwh + (parsed.usage_kwh as number);
  }

  // 6. Correcting a paid bill's usage changes what was paid for: the person
  //    ticks that they know it is paid, as billing.record-usage's prepare
  //    asks, after every refusal above, so they are not asked to confirm a
  //    correction the route would refuse anyway.
  if (bill.payment_status === "paid" && !parsed.confirmation?.acknowledged.includes(REGENERATE_PAID_ACKNOWLEDGEMENT)) {
    return NextResponse.json(
      {
        error: "This bill is marked paid. Confirm that you want to correct its usage anyway.",
        reason: "paid_acknowledgement_required",
      },
      { status: 428 }
    );
  }

  // 7. The bill as read here, which every check above was made on. The
  //    write (fn_regenerate_bill_with_audit) refuses, under locks held to
  //    commit, unless the period is still a draft and the bill still has no
  //    invoice number and these values: a payment, refund, invoice number,
  //    close or regeneration since this read answers 409 and writes nothing.
  const expectedBill: ExpectedBill = {
    lineItemId: bill.id,
    tenantId: bill.tenant_id,
    paymentStatus: bill.payment_status,
    totalAmount: Number(bill.total_amount),
    usageKwh: numOrNull(bill.usage_kwh),
    startKwh,
    endKwh: numOrNull(bill.end_kwh),
    readingSource: bill.reading_source,
    deviceId: bill.device_id,
    tierBreakdown: bill.tier_breakdown,
    enteredByUserId: bill.entered_by_user_id,
    manualReason: bill.manual_reason,
  };

  // 8. A per-bill regeneration for this bill's one tenant (mode='write').
  const out = await runGenerationFor({
    supabase,
    periodId: period.id,
    tenantIds: [bill.tenant_id],
    manualReadings: [
      {
        tenantId: bill.tenant_id,
        startKwh,
        endKwh: nextEnd,
      },
    ],
    mode: "write",
    actorUserId: user.id,
    expectedBill,
    meteringProvider: (await getMgmRuntime()).meteringProviders.forRequest(supabase),
  });

  if (isRunGenerationFatal(out)) {
    // Pass-through fatal status (e.g. 400 missing rate schedule).
    const reason =
      out.status === 400
        ? "missing_rate_schedule"
        : out.status === 404
          ? "not_found"
          : "unknown_error";
    return NextResponse.json(
      {
        error: out.body.error,
        reason,
        ...(out.body.code ? { code: out.body.code } : {}),
      },
      { status: out.status }
    );
  }

  // Locate the per-tenant result for our line item.
  const result = out.results.find((r) => r.tenantId === bill.tenant_id);
  if (!result) {
    return NextResponse.json(
      {
        error: "Failed to update line item: no result returned.",
        reason: "unknown_error",
      },
      { status: 500 }
    );
  }
  if (result.kind === "error") {
    // Preserve the historical 400 invalid_body shape for invalid_manual_reading.
    if (result.code === "invalid_manual_reading") {
      return NextResponse.json(
        { error: result.error, reason: "invalid_body" },
        { status: 400 }
      );
    }
    // The bill changed between the read above and the write: nothing was written.
    if (result.code in WRITE_REFUSALS) {
      const code = result.code as keyof typeof WRITE_REFUSALS;
      return refused(WRITE_REFUSALS[code], code);
    }
    return NextResponse.json(
      { error: result.error, reason: "unknown_error" },
      { status: 500 }
    );
  }
  if (result.kind === "unchanged") {
    // The same correction sent again: nothing written, no audit row. The
    // bill is as it was read.
    return NextResponse.json({ lineItem: bill }, { status: 200 });
  }
  if (result.kind === "preview" || result.kind === "kept") {
    // Should never happen: this is a write, and a manualReadings entry for
    // the tenant lifts the engine's keep-manual guard.
    return NextResponse.json(
      { error: "Internal error: line item was not rewritten.", reason: "unknown_error" },
      { status: 500 }
    );
  }

  return NextResponse.json({ lineItem: result.lineItem }, { status: 200 });
}
