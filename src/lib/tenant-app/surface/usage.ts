import "server-only";

/**
 * The loaders of the `tenant.usage-month` and `tenant.usage-day` views: the
 * caller's own unit's use per day of a month and per hour of a day, read
 * through the tenant app capability (RFC mgm#197 § 5). The host picked the
 * unit among the caller's tenant rows (dispatchTenantView in
 * @/lib/gui/host/server/view) and passes only the view's own query
 * parameter; composeTenantApp authorizes the unit again with the caller's
 * own session and refuses while the tenant app is off for the unit's
 * organization, before anything else is read.
 *
 * The capability reads the meters' figures through the usage source, which
 * reaches the metering provider on the service role
 * (../infrastructure/usage-source.ts), and serves a read again from its
 * cache for a minute, so neither happens before that authorization. A failed
 * or refused read is not a refusal: the view loads and shows no data. Only
 * the composition and the meter links read refuse it, with fixed copy chosen
 * by status, never the capability's message.
 */
import type { Loaded, LoadedModel, TenantRequest } from "@/lib/gui/surface";
import { tenantUnitIds } from "@/lib/gui/host/shared/tenant-units";
import { composeTenantApp } from "../compose";
import { buildUsageDayModel, buildUsageMonthModel, type UsageLinkContext } from "./usage-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const TENANT_USAGE_REFUSALS = {
  signedOut: { ok: false, status: 403, message: "Your session has ended. Sign in again to see your use." },
  notFound: { ok: false, status: 404, message: "This unit could not be found." },
  disabled: { ok: false, status: 409, message: "The tenant app is not turned on for your unit yet." },
  failed: { ok: false, status: 500, message: "Your use could not be loaded." },
  unavailable: { ok: false, status: 503, message: "Your use could not be loaded right now. Try again shortly." },
} as const satisfies Record<string, Refusal>;

/**
 * A tenant app failure as these views' refusal, mapped as the tenant home's
 * (tenantHomeRefusal in ./home.ts): a 401 is a session that ended after the
 * host checked it; a 400 or 403 is a unit no longer the caller's, which
 * reads as not found; a 409 is the plugin gate's refusal of the tenant app,
 * the only 409 these loaders answer (dispatchTenantView shows it as a page
 * not in this release).
 */
export function tenantUsageRefusal(failure: { status: number }): Refusal {
  const { status } = failure;
  if (status === 401) return TENANT_USAGE_REFUSALS.signedOut;
  if (status === 409) return TENANT_USAGE_REFUSALS.disabled;
  if (status >= 400 && status < 500) return TENANT_USAGE_REFUSALS.notFound;
  if (status === 500) return TENANT_USAGE_REFUSALS.failed;
  return TENANT_USAGE_REFUSALS.unavailable;
}

/**
 * The one value of a parameter, or undefined when it is absent or repeated,
 * so a repeated `?month=` or `?date=` shows the current period, as the
 * Operations day treats a repeated `?date=` (resolveRequestedDay).
 */
function single(values: string[]): string | undefined {
  return values.length === 1 ? values[0] : undefined;
}

/** Whether the hrefs in the ext name the unit: only for a person with several units. */
function linkContext(req: TenantRequest): UsageLinkContext {
  return { tenantId: req.tenantId, several: tenantUnitIds(req.roles).length > 1 };
}

export async function loadTenantUsageMonth(req: TenantRequest): Promise<Loaded<LoadedModel<"collection">>> {
  const composed = await composeTenantApp({ supabase: req.supabase, tenantId: req.tenantId, now: () => req.now.getTime() });
  if (!composed.ok) return tenantUsageRefusal(composed);
  try {
    const month = await composed.data.tenantApp.getUsageMonth({ month: single(req.search.getAll("month")) });
    if (!month.ok) return tenantUsageRefusal(month);
    return { ok: true, model: buildUsageMonthModel(month.data, { fmt: req.fmt, locale: req.locale, links: linkContext(req) }) };
  } finally {
    await composed.data.dispose();
  }
}

export async function loadTenantUsageDay(req: TenantRequest): Promise<Loaded<LoadedModel<"collection">>> {
  const composed = await composeTenantApp({ supabase: req.supabase, tenantId: req.tenantId, now: () => req.now.getTime() });
  if (!composed.ok) return tenantUsageRefusal(composed);
  try {
    const day = await composed.data.tenantApp.getUsageDay({ date: single(req.search.getAll("date")) });
    if (!day.ok) return tenantUsageRefusal(day);
    return { ok: true, model: buildUsageDayModel(day.data, { fmt: req.fmt, locale: req.locale, links: linkContext(req) }) };
  } finally {
    await composed.data.dispose();
  }
}
