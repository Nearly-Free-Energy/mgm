import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromToken, resolveMicrogridOrgId } from "@/lib/internal-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getMgmRuntime } from "@/lib/runtime/root";
import { gateRoute } from "@/lib/runtime/gate";
import { runGenerationFor, isRunGenerationFatal } from "@/lib/billing/generate";
import { V1GenerateBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";

export async function POST(request: NextRequest) {
  // #255 — per-org token auth replaces the dead-code INTERNAL_API_KEY
  // model from PR #246. On failure, return the structured reason as the
  // error body.
  const auth = await resolveOrgFromToken(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  // After the token check, so a missing token answers 401 before the body
  // is read. Unknown keys, at the top level or in a reading, are dropped,
  // not refused, and a reason that is not a string is dropped
  // (V1GenerateBody).
  const parsed = await parseJsonBody(request, V1GenerateBody);
  if (!parsed.ok) return parsed.response;
  const rec = parsed.data;

  // #254 — the payload MUST assert which microgrid the caller is operating
  // against: the customerapp should know its target microgrid up front, and
  // the route cross-checks both the payload microgrid AND the resolved
  // period's microgrid against the token's org below.

  // manualReadings is OPTIONAL. When omitted (or an empty array), every
  // tenant's usage is pulled from OpenEMS over the billing period — the
  // automated-billing path: a scheduled caller POSTs with no manualReadings and
  // the engine resolves each tenant's consumption from the OpenEMS B2B API.
  // When present, each entry overrides that tenant's reading; all other
  // tenants still resolve from OpenEMS. tenantIds is left undefined so the
  // engine bills the period microgrid's full tenant set.
  const manualReadings = (rec.manualReadings ?? []).map((m) => ({
    tenantId: m.tenantId,
    startKwh: m.startKwh,
    endKwh: m.endKwh,
    ...(typeof m.reason === "string" ? { reason: m.reason } : {}),
  }));

  const supabase = createServiceClient();

  // #254 — Authorization layer (defense in depth):
  //
  // We resolve TWO microgrid → org chains and assert both equal the token's
  // org. Both must be checked in this exact order:
  //
  //   1. Payload microgrid_id → org (404 BEFORE 403 — UUID-enumeration
  //      defense; never reveal "exists in some other org").
  //   2. Period's microgrid_id → org (a stolen/replayed billingPeriodId from
  //      another org must not generate against the caller's session).
  //
  // The two microgrid ids are not compared with each other: a payload
  // microgrid_id for another microgrid of the same org passes, and
  // generation runs on the period's microgrid, because `runGenerationFor`
  // takes no microgrid id (src/lib/billing/generate.ts). If it starts
  // taking one, revisit.
  const mg = await resolveMicrogridOrgId(supabase, rec.microgrid_id);
  if (!mg.ok) {
    return NextResponse.json({ error: mg.reason }, { status: mg.status });
  }
  if (mg.org_id !== auth.org_id) {
    return NextResponse.json(
      { error: "microgrid_outside_token_org" },
      { status: 403 },
    );
  }

  // Period-resolution mirror — pull the period's microgrid_id, then run
  // it through the same chain. Same 404-before-403 ordering applies.
  const { data: periodRow, error: periodErr } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id")
    .eq("id", rec.billingPeriodId)
    .maybeSingle();
  if (periodErr || !periodRow) {
    return NextResponse.json(
      { error: "billing_period_not_found" },
      { status: 404 },
    );
  }
  const periodMg = await resolveMicrogridOrgId(supabase, periodRow.microgrid_id);
  if (!periodMg.ok) {
    // The period row exists but its microgrid_id can't be resolved —
    // treat as not-found (the period's microgrid was deleted, or some
    // FK-cascade race). Surface as 404 to stay consistent with the
    // missing-period branch above.
    return NextResponse.json(
      { error: "billing_period_not_found" },
      { status: 404 },
    );
  }
  if (periodMg.org_id !== auth.org_id) {
    return NextResponse.json(
      { error: "microgrid_outside_token_org" },
      { status: 403 },
    );
  }

  // MGM runtime gate, after the 404/403 ordering above so a disabled plugin
  // never reveals that a period exists in another organization.
  const pluginGate = await gateRoute(supabase, {
    plugin: "billing",
    target: { kind: "organization", id: auth.org_id },
    method: "POST",
  });
  if (pluginGate) return pluginGate;
  // The metering source comes from the runtime's provider registry, the
  // same one the dashboard's billing capability uses.
  const runtime = await getMgmRuntime();

  // SIGNATURE NOTE: `fn_record_line_item_with_audit` was widened in #250
  // (actor_kind, actor_ref) — see `src/lib/billing/generate.ts` for the
  // full rationale + PostgREST overload-resolution caveat.
  //
  // #255 — actor_ref is now the real per-org token name resolved by
  // `resolveOrgFromToken`, replacing the `'pre-token-system'` placeholder
  // from #250.
  const out = await runGenerationFor({
    supabase,
    periodId: rec.billingPeriodId,
    manualReadings,
    mode: "write",
    actorUserId: null,
    actorKind: "customerapp",
    actorRef: auth.token_name,
    meteringProvider: runtime.meteringProviders.forRequest(supabase),
  });

  if (isRunGenerationFatal(out)) {
    return NextResponse.json(out.body, { status: out.status });
  }

  // #255 — response shape returns per-line-item entity IDs so the
  // customerapp can reference generated line items downstream (e.g. for
  // payment-link generation). PR #246 returned `{ lineItems: <count> }`;
  // the new shape per the AC ("POST /api/v1/billing/generate response
  // includes per-line-item IDs (full entity-IDs commitment per #249)").
  const lineItems = out.results
    .filter((r): r is Extract<typeof r, { kind: "written" }> => r.kind === "written")
    .map((r) => ({
      id: r.lineItem.id,
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      totalAmount: r.lineItem.total_amount,
      usageKwh: r.lineItem.usage_kwh,
    }));

  // Tenants already on a manual reading for this period are not re-read
  // from OpenEMS by this bulk path (see "Manual rows" in generate.ts); they
  // are listed so the caller can tell them from tenants that failed.
  const kept = out.results
    .filter((r) => r.kind === "kept")
    .map((k) => ({ tenantId: k.tenantId, tenantName: k.tenantName }));

  const errors = out.results
    .filter((r) => r.kind === "error")
    .map((e) => ({
      tenantId: e.tenantId,
      tenantName: e.tenantName,
      error: e.error,
      code: e.code,
    }));

  return NextResponse.json({ lineItems, kept, errors });
}
