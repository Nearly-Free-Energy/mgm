import { NextRequest, NextResponse } from "next/server";
import { composeBillingReview, isRunGenerationFatal } from "@/lib/cordis/billing-review";
import { isMgmReviewer } from "@/lib/mgm/access";
import { createClient } from "@/lib/supabase/server";
import { checkGate, gateResponse } from "@/lib/runtime/gate";
import { BILLING_REVIEW_MAX_TENANTS, PreviewBillingReviewBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

export const runtime = "nodejs";

/**
 * Read-only MGM bill comparison. The route operates entirely through the
 * user-scoped Supabase client, runs in an isolated request scope on the MGM
 * Cordis runtime, and never accepts manual readings or a provider name from the browser:
 * the body is parsed with `PreviewBillingReviewBody` (`@/lib/billing/schemas`), which
 * refuses any key but periodId and tenantIds with 400 { error, field?, code: "invalid_body" }.
 */
export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody(request, PreviewBillingReviewBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isMgmReviewer(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // This RLS-governed lookup also supplies period provenance for the review.
  const { data: period, error: periodError } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id, start_date, end_date, timezone")
    .eq("id", body.periodId)
    .maybeSingle();
  if (periodError || !period) {
    return NextResponse.json({ error: "billing_period_not_found" }, { status: 404 });
  }
  // Preview may re-pin an empty draft, so it is a billing write.
  const gate = await checkGate(supabase, {
    plugin: "billing",
    target: { kind: "billingPeriod", id: body.periodId },
    method: "POST",
  });
  if (!gate.ok) return gateResponse(gate);
  // The gate resolved the period's organization for this write; a period
  // whose organization the caller cannot see is treated as missing.
  const organizationId = gate.organizationId;
  if (!organizationId) {
    return NextResponse.json({ error: "billing_period_not_found" }, { status: 404 });
  }

  let tenantIds = body.tenantIds;
  if (tenantIds === undefined) {
    const { data: tenants, error: tenantsError } = await supabase
      .from("tenants")
      .select("id")
      .eq("microgrid_id", period.microgrid_id)
      .limit(BILLING_REVIEW_MAX_TENANTS + 1);
    if (tenantsError) {
      return NextResponse.json({ error: "tenants_unavailable" }, { status: 500 });
    }
    if ((tenants ?? []).length > BILLING_REVIEW_MAX_TENANTS) {
      return NextResponse.json(
        { error: "too_many_tenants", details: "Select at most 500 tenants for one review" },
        { status: 413 },
      );
    }
    tenantIds = (tenants ?? []).map((tenant) => tenant.id);
  }

  // This optional pilot ledger is not present in older databases. When it is
  // available, expose only the baseline timestamp, never batch/source data.
  const { data: baselineBatch } = await supabase
    .from("pilot_import_batches")
    .select("applied_at")
    .eq("billing_period_id", body.periodId)
    .eq("is_baseline", true)
    .eq("status", "applied")
    .order("applied_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const calculatedAt = new Date().toISOString();
  const composition = await composeBillingReview({ supabase, organizationId, userId: user.id });
  try {
    // The provider is selected server-side. Fixture registration is absent
    // from this production composition, so a request cannot switch providers.
    const generated = await composition.billingReview.preview({
      periodId: body.periodId,
      tenantIds,
      provider: "openems",
    });
    if (isRunGenerationFatal(generated)) {
      return NextResponse.json(generated.body, { status: generated.status });
    }

    const rows = generated.results.map((result) => {
      if (result.kind === "preview") {
        const hasSavedBill = result.previousTotalAmount !== null;
        return {
          tenantId: result.tenantId,
          label: `Tenant ${result.tenantId.slice(0, 8)}`,
          savedUsageKwh: result.previousUsageKwh,
          savedAmount: result.previousTotalAmount,
          proposedUsageKwh: result.usageKwh,
          proposedAmount: result.totalAmount,
          usageDifferenceKwh:
            result.previousUsageKwh === null ? null : result.usageKwh - result.previousUsageKwh,
          amountDifference:
            result.previousTotalAmount === null ? null : result.totalAmount - result.previousTotalAmount,
          status: hasSavedBill ? "comparable" : "excluded",
          exceptions: hasSavedBill
            ? []
            : [{ code: "missing_saved_bill", message: "No imported bill is available for comparison" }],
          provenance: {
            provider: "openems" as const,
            calculatedAt,
            periodTimezone: period.timezone,
          },
        };
      }
      if (result.kind === "error") return {
        tenantId: result.tenantId,
        label: `Tenant ${result.tenantId.slice(0, 8)}`,
        savedUsageKwh: null,
        savedAmount: null,
        proposedUsageKwh: null,
        proposedAmount: null,
        usageDifferenceKwh: null,
        amountDifference: null,
        status: "error" as const,
        exceptions: [{ code: result.code, message: result.error }],
        provenance: {
          provider: "openems" as const,
          calculatedAt,
          periodTimezone: period.timezone,
        },
      };
      return {
        tenantId: result.tenantId,
        label: `Tenant ${result.tenantId.slice(0, 8)}`,
        savedUsageKwh: null,
        savedAmount: null,
        proposedUsageKwh: null,
        proposedAmount: null,
        usageDifferenceKwh: null,
        amountDifference: null,
        status: "error" as const,
        exceptions: [{ code: "unexpected_generation_result", message: "Preview returned a write result" }],
        provenance: {
          provider: "openems" as const,
          calculatedAt,
          periodTimezone: period.timezone,
        },
      };
    });

    return NextResponse.json({
      period: {
        id: period.id,
        startDate: period.start_date,
        endDate: period.end_date,
        timezone: period.timezone,
        tariffName: null,
        baselineImportedAt: baselineBatch?.applied_at ?? null,
      },
      rows,
      calculatedAt,
      errors: rows
        .filter((row) => row.status === "error")
        .flatMap((row) => row.exceptions),
    });
  } finally {
    await composition.dispose();
  }
}
