import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { composeBilling, type BillingResult } from "@/lib/billing/compose";
import { notBilledCount, summarizeGenerateFromMeters } from "@/lib/billing/generate-from-meters-summary";
import { GENERATE_FROM_METERS_COPY, GenerateFromMetersBody } from "@/lib/billing/schemas";
import { createFmt } from "@/lib/gui/fmt";
import { formatLocale } from "@/lib/locale";
import { parseJsonBody } from "@/lib/validation/parse-body";

/**
 * POST /api/billing-periods/[periodId]/generate-from-meters (#201)
 *
 * Generates a draft period's bills from meter data: the period review's
 * `billing.generate-from-meters`. A thin adapter over the billing
 * capability (BillingCapability.generateFromMeters), which runs the same
 * engine POST /api/billing/generate does, for every tenant of the period's
 * microgrid and with no readings given. It adds no billing logic. Unlike
 * that route it refuses a closed period, keeps manual bills, leaves
 * invoiced, paid and refunded bills as they are, and changes any other
 * existing bill only as it was read (guardExistingBills in
 * src/lib/billing/generate.ts): a bill paid, invoiced or regenerated
 * meanwhile is left too, and a second run writes nothing it does not need.
 * A tenant with no meter for the period, a meter assignment gap or no meter
 * data gets no bill (#293), and keeps the bill they had if they had one:
 * the result counts both. The engine reads the period's status again after
 * reading the meters and refuses, writing nothing, if it closed meanwhile.
 * A tenant's first bill is inserted through
 * fn_record_first_line_item_with_audit, only while the period is a draft
 * and the tenant has no bill, under the period's lock: a close committing
 * after that second read refuses the insert, and a bill inserted for that
 * tenant by another write while this run reads the meters (a manual
 * reading, a bill from readings, or an overlapping run) is left as it is;
 * the result counts both as changed (guardExistingBills in
 * src/lib/billing/generate.ts).
 *
 * Body (GenerateFromMetersBody): `{}`. The period is the path's.
 *
 * Responses:
 *   200 → { generated, paymentLinksCleared, unchanged, kept, left, changed,
 *           notRefreshed, notBilled: { noMeter, meterAssignment, noReading, failed },
 *           tenants: [{ tenantId, tenantName, outcome, code? }], message }
 *         — counts by outcome (generate-from-meters-summary.ts); `code` is the
 *         engine's GenerationErrorCode for a tenant left or not billed, never
 *         its text; `message` sums the counts up in fixed copy, in the
 *         request's locale, within the 300 characters the GUI host keeps.
 *         The count `left` is paid, invoiced and refunded bills only, while a
 *         tenant's outcome "left" also covers the bills counted in `changed`
 *         and `notRefreshed` (GenerateFromMetersCounts says which is which);
 *         `paymentLinksCleared` is the bills written whose pending payment
 *         link stopped working because their total changed.
 *   400 → { error, field?, code: "invalid_body" } (anything but `{}`);
 *         { error, reason: "bad_request" } (id)
 *   401 → { error: "unauthorized" }
 *   404 → { error, reason: "not_found" } (period or microgrid hidden by RLS:
 *         another organization's, or a tenant-only account's)
 *   409 → { error, reason: "period_closed" } (nothing written: refused
 *         before the meters are read, or after, if the period closed while
 *         they were read);
 *         { error, reason: "no_tariff" } (no rate schedule to pin);
 *         { error, reason: "nothing_generated", …the 200 body } when no
 *         tenant was billed or found up to date and some were not billed,
 *         or had a bill not refreshed: nothing was written,
 *         and `error` is the summary;
 *         { error, reason: "nothing_to_read" } (no tenants)
 *   503 → { error, reason: "metering_unavailable" } (the metering source
 *         failed; nothing was written)
 *   500 → { error, reason: "unknown_error" }
 *   and the capability's own refusals (plugin gate, organization scope),
 *   with their fixed copy. Every refusal is fixed copy, never a database's
 *   or metering source's message.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => NextResponse.json({ error: "Billing period not found.", reason: "not_found" }, { status: 404 });
const refuse = (status: number, error: string, reason: string) => NextResponse.json({ error, reason }, { status });

/**
 * The capability's refusals whose message is fixed copy of its own
 * (composeBilling and BillingCapability), passed on as they are. Anything
 * else from it, or from the engine, is mapped to this route's copy below; if
 * the capability adds a refusal with fixed copy, it may be listed here.
 */
const CAPABILITY_REFUSALS = new Set([
  "billing_disabled",
  "billing_gate_unavailable",
  "billing_forbidden",
  "billing_scope_mismatch",
  "billing_unauthenticated",
  "billing_invalid_org",
  "billing_invalid_period",
]);

function mapError(error: Extract<BillingResult<never>, { ok: false }>) {
  if (CAPABILITY_REFUSALS.has(error.code)) {
    return NextResponse.json({ error: error.message, code: error.code, ...(error.reason ? { reason: error.reason } : {}) }, { status: error.status });
  }
  if (error.code === "billing_period_closed") return refuse(409, GENERATE_FROM_METERS_COPY.closed, "period_closed");
  if (error.code === "RATE_SCHEDULE_UNPINNED") return refuse(409, GENERATE_FROM_METERS_COPY.noTariff, "no_tariff");
  if (error.code.startsWith("METERING_")) return refuse(503, GENERATE_FROM_METERS_COPY.meters, "metering_unavailable");
  if (error.status === 404) return notFound();
  return refuse(500, GENERATE_FROM_METERS_COPY.failed, "unknown_error");
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ periodId: string }> }): Promise<NextResponse> {
  const { periodId } = await params;
  if (!UUID_RE.test(periodId)) {
    return NextResponse.json({ error: "Invalid billing period id — expected UUID.", reason: "bad_request" }, { status: 400 });
  }

  // Before the session check, as on the other billing routes: a malformed body answers 400 whoever sends it.
  const body = await parseJsonBody(request, GenerateFromMetersBody);
  if (!body.ok) return body.response;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Read through the person's own client: a period RLS hides is a 404. A
  // failed read is not a missing row: it answers 500.
  const { data: period, error: periodError } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id, status")
    .eq("id", periodId)
    .maybeSingle<{ id: string; microgrid_id: string; status: string }>();
  if (periodError) return refuse(500, GENERATE_FROM_METERS_COPY.failed, "unknown_error");
  if (!period) return notFound();
  const { data: microgrid, error: microgridError } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", period.microgrid_id)
    .maybeSingle<{ id: string; communities: { org_id: string } | { org_id: string }[] }>();
  if (microgridError) return refuse(500, GENERATE_FROM_METERS_COPY.failed, "unknown_error");
  const communities = microgrid?.communities;
  const orgId = Array.isArray(communities) ? communities[0]?.org_id : communities?.org_id;
  if (!orgId) return notFound();

  // Organization scope and the billing plugin gate.
  const composed = await composeBilling({ supabase, organizationId: orgId });
  if (!composed.ok) return mapError(composed);

  try {
    // Before anything is read from the meters; the engine refuses it again,
    // before reading them and before its first write, and its writes to
    // existing bills check it under their locks.
    if (period.status !== "draft") return refuse(409, GENERATE_FROM_METERS_COPY.closed, "period_closed");

    const result = await composed.data.billing.generateFromMeters(period.id);
    if (!result.ok) return mapError(result);

    if (result.data.results.length === 0) return refuse(409, GENERATE_FROM_METERS_COPY.nothingToRead, "nothing_to_read");
    const summary = summarizeGenerateFromMeters(result.data.results, createFmt({ locale: formatLocale(request.headers.get("accept-language")) }));
    // Nothing written and nothing up to date, with tenants not billed or
    // bills not refreshed: an answer a GUI that shows only failures still shows.
    if (summary.generated === 0 && summary.unchanged === 0 && notBilledCount(summary) + summary.notRefreshed > 0) {
      return NextResponse.json({ ...summary, error: summary.message, reason: "nothing_generated" }, { status: 409 });
    }
    return NextResponse.json(summary);
  } finally {
    await composed.data.dispose();
  }
}
