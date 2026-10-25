import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  composeBilling,
  type BillingResult,
} from "@/lib/billing/compose";
import type { ManualReadingInput } from "@/lib/billing/generate";
import { checkGate, gateResponse } from "@/lib/runtime/gate";

function mapError(error: Extract<BillingResult<never>, { ok: false }>) {
  const { ok, status, ...body } = error;
  void ok;
  return NextResponse.json(body, { status });
}

/**
 * POST /api/billing/regenerate-preview (#173, BC1)
 *
 * Same request body as /api/billing/generate. Writes no bills or line
 * items, but an empty draft period's tariff is re-pinned so preview and
 * write price against the same schedule — which makes this a billing write
 * for the plugin gate. The OpenEMS read still happens (it's an HTTP call,
 * not a transaction). Returns the per-household preview that BC3's
 * compute-then-confirm dialog (Q6) renders.
 *
 * Body:
 *   { billingPeriodId: string;
 *     householdIds?: string[];
 *     manualReadings?: Array<{
 *       householdId: string;
 *       startKwh: number;
 *       endKwh: number;
 *       reason?: string;
 *     }>;
 *   }
 *
 * Response:
 *   { preview: Array<{
 *       householdId, householdName, startKwh, endKwh, usageKwh,
 *       tierBreakdown, totalAmount,
 *       previousTotalAmount, previousPaymentStatus,
 *     }>;
 *     errors: Array<{ householdId, householdName, error, code? }>;
 *   }
 *
 * `previousPaymentStatus` is the row's state BEFORE the regenerate would
 * write — preserved across the regenerate (AC3). DO NOT rename to
 * `currentPaymentStatus` — BC3 #175 already drafts `previousPaymentStatus`
 * consumption.
 *
 * Release 3 (issue #5, review P1): the compute runs through the billing
 * Cordis capability (composeBilling + previewBills) with effective-dated
 * meter-assignment coverage enforced, so the preview the operator confirms
 * can never promise bills the write path would refuse.
 *
 * Refusals, in order: 400 body; 401 no session; 404 period not visible;
 * the composer's 400/401/403 (organization access); the billing gate's
 * 409/503; 404 when the gate resolved the period to another organization.
 * Access is checked before the gate so a caller without access to the
 * organization gets 403, not a 409/503 that reveals whether billing is on
 * there. The capability runs only after every check has passed.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RawManualReading = {
  householdId: unknown;
  startKwh: unknown;
  endKwh: unknown;
  reason?: unknown;
};

type ParseError = { error: string };

type ParsedBody = {
  billingPeriodId: string;
  householdIds?: string[];
  manualReadings?: ManualReadingInput[];
};

/** Same shape as the generate route's parser — kept inline because the
 * route surface is small and the validation matrix is identical. */
function parseBody(raw: unknown): { parsed: ParsedBody } | ParseError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Body must be an object" };
  }
  const rec = raw as Record<string, unknown>;

  if (
    typeof rec.billingPeriodId !== "string" ||
    !UUID_RE.test(rec.billingPeriodId)
  ) {
    return { error: "billingPeriodId must be a UUID string" };
  }
  const billingPeriodId = rec.billingPeriodId;

  let householdIds: string[] | undefined;
  if (rec.householdIds !== undefined) {
    if (!Array.isArray(rec.householdIds)) {
      return { error: "householdIds must be an array of UUIDs" };
    }
    for (const h of rec.householdIds) {
      if (typeof h !== "string" || !UUID_RE.test(h)) {
        return { error: "householdIds entries must be UUID strings" };
      }
    }
    householdIds = rec.householdIds as string[];
  }

  let manualReadings: ManualReadingInput[] | undefined;
  if (rec.manualReadings !== undefined) {
    if (!Array.isArray(rec.manualReadings)) {
      return { error: "manualReadings must be an array" };
    }
    const out: ManualReadingInput[] = [];
    for (let i = 0; i < rec.manualReadings.length; i++) {
      const m = rec.manualReadings[i] as RawManualReading;
      if (!m || typeof m !== "object") {
        return { error: `manualReadings[${i}] must be an object` };
      }
      if (typeof m.householdId !== "string" || !UUID_RE.test(m.householdId)) {
        return { error: `manualReadings[${i}].householdId must be a UUID` };
      }
      if (
        typeof m.startKwh !== "number" ||
        !Number.isFinite(m.startKwh) ||
        m.startKwh < 0
      ) {
        return {
          error: `manualReadings[${i}].startKwh must be a non-negative finite number`,
        };
      }
      if (
        typeof m.endKwh !== "number" ||
        !Number.isFinite(m.endKwh) ||
        m.endKwh < 0
      ) {
        return {
          error: `manualReadings[${i}].endKwh must be a non-negative finite number`,
        };
      }
      if (m.endKwh < m.startKwh) {
        return { error: `manualReadings[${i}].endKwh must be >= startKwh` };
      }
      let reason: string | undefined;
      if (m.reason !== undefined) {
        if (typeof m.reason !== "string") {
          return { error: `manualReadings[${i}].reason must be a string` };
        }
        if (m.reason.length > 500) {
          return { error: `manualReadings[${i}].reason must be <= 500 chars` };
        }
        reason = m.reason;
      }
      out.push({
        householdId: m.householdId,
        startKwh: m.startKwh,
        endKwh: m.endKwh,
        reason,
      });
    }
    manualReadings = out;
  }

  return { parsed: { billingPeriodId, householdIds, manualReadings } };
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = parseBody(raw);
  if ("error" in parseResult) {
    return NextResponse.json(
      { error: "invalid_body", details: parseResult.error },
      { status: 400 }
    );
  }
  const { parsed } = parseResult;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Release 3 (issue #5, review P1): same capability routing as the write
  // path — org scope, plugin gate, and assignment-date enforcement apply to
  // the preview too.
  const { data: period } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id")
    .eq("id", parsed.billingPeriodId)
    .maybeSingle<{ id: string; microgrid_id: string }>();
  if (!period) {
    return NextResponse.json({ error: "Billing period not found" }, { status: 404 });
  }
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", period.microgrid_id)
    .maybeSingle<{
      id: string;
      communities: { org_id: string } | { org_id: string }[];
    }>();
  const communities = microgrid?.communities;
  const orgId = Array.isArray(communities)
    ? communities[0]?.org_id
    : communities?.org_id;
  if (!orgId) {
    return NextResponse.json({ error: "Billing period not found" }, { status: 404 });
  }

  // Composing first authorizes the caller for the organization (401/403)
  // before anything reveals the plugin's state. `readOnly` skips only the
  // composer's plugin check, which the gate below replaces: preview can
  // re-pin an empty draft's tariff (`runGenerationFor` calls
  // `fn_pin_billing_period_rate_schedule` in preview mode too), so it is a
  // billing write. If preview stops pinning, revisit.
  const composed = await composeBilling({ supabase, organizationId: orgId, readOnly: true });
  if (!composed.ok) return mapError(composed);

  try {
    // Inside the try, so a refusal still disposes the scope opened above.
    const gate = await checkGate(supabase, {
      plugin: "billing",
      target: { kind: "billingPeriod", id: parsed.billingPeriodId },
      method: "POST",
    });
    if (!gate.ok) return gateResponse(gate);
    // The gate resolved the period's organization on its own; it must be the
    // one the scope was authorized for. For a write on a non-core plugin the
    // gate passes with `null` only when it cannot see the period, so `null`
    // is a 404 like the lookups above. If billing becomes core or this stops
    // being a write, the gate passes `null` unchecked and this refuses every
    // request.
    if (gate.organizationId !== orgId) {
      return NextResponse.json({ error: "Billing period not found" }, { status: 404 });
    }

    const result = await composed.data.billing.previewBills({
      billingPeriodId: parsed.billingPeriodId,
      householdIds: parsed.householdIds,
      manualReadings: parsed.manualReadings,
    });
    if (!result.ok) return mapError(result);

    const preview = result.data.results
      .filter((r) => r.kind === "preview")
      .map((p) => ({
        householdId: p.householdId,
        householdName: p.householdName,
        startKwh: p.startKwh,
        endKwh: p.endKwh,
        usageKwh: p.usageKwh,
        tierBreakdown: p.tierBreakdown,
        totalAmount: p.totalAmount,
        previousTotalAmount: p.previousTotalAmount,
        previousPaymentStatus: p.previousPaymentStatus,
      }));

    const errors = result.data.results
      .filter((r) => r.kind === "error")
      .map((e) => ({
        householdId: e.householdId,
        householdName: e.householdName,
        error: e.error,
        code: e.code,
      }));

    return NextResponse.json({ preview, errors });
  } finally {
    await composed.data.dispose();
  }
}
