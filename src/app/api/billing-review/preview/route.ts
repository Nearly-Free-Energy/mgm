import { NextRequest, NextResponse } from "next/server";
import { composeBillingReview, isRunGenerationFatal } from "@/lib/cordis/billing-review";
import { isMgmReviewer } from "@/lib/mgm/access";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PreviewBody = { periodId: string; householdIds?: string[] };

function parseBody(raw: unknown): PreviewBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.periodId !== "string" || !UUID_RE.test(record.periodId)) return null;
  if (record.householdIds === undefined) return { periodId: record.periodId };
  if (
    !Array.isArray(record.householdIds) ||
    !record.householdIds.every((id) => typeof id === "string" && UUID_RE.test(id))
  ) {
    return null;
  }
  return { periodId: record.periodId, householdIds: record.householdIds };
}

/**
 * Read-only MGM bill comparison. The route operates entirely through the
 * user-scoped Supabase client, makes a fresh Cordis context per request, and
 * never accepts manual readings or a provider name from the browser.
 */
export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const body = parseBody(raw);
  if (!body) {
    return NextResponse.json(
      { error: "invalid_body", details: "periodId and householdIds must be UUIDs" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isMgmReviewer(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // This RLS-governed lookup also supplies period provenance for the review.
  const { data: period, error: periodError } = await supabase
    .from("billing_periods")
    .select("id, start_date, end_date, timezone")
    .eq("id", body.periodId)
    .maybeSingle();
  if (periodError || !period) {
    return NextResponse.json({ error: "billing_period_not_found" }, { status: 404 });
  }

  const composition = await composeBillingReview({ supabase });
  const calculatedAt = new Date().toISOString();
  try {
    // The provider is selected server-side. Fixture registration is absent
    // from this production composition, so a request cannot switch providers.
    const generated = await composition.billingReview.preview({
      periodId: body.periodId,
      householdIds: body.householdIds,
      provider: "openems",
    });
    if (isRunGenerationFatal(generated)) {
      return NextResponse.json(generated.body, { status: generated.status });
    }

    const rows = generated.results.map((result) => {
      if (result.kind === "preview") {
        const hasSavedBill = result.previousTotalAmount !== null;
        return {
          householdId: result.householdId,
          label: `Household ${result.householdId.slice(0, 8)}`,
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
        householdId: result.householdId,
        label: `Household ${result.householdId.slice(0, 8)}`,
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
        householdId: result.householdId,
        label: `Household ${result.householdId.slice(0, 8)}`,
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
        baselineImportedAt: null,
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
