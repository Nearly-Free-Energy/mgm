import "server-only";

/**
 * The loader of the `tenant.home` view: the caller's own unit, read through
 * the tenant app capability (RFC mgm#197 § 3). The host picked the unit among
 * the caller's tenant rows (dispatchView in src/lib/gui/host/server/view.ts);
 * composeTenantApp authorizes it again with the caller's own session and
 * refuses while the tenant app is off for the unit's organization.
 *
 * A refusal carries fixed copy chosen by status and code, never the
 * capability's message.
 */
import type { Loaded, LoadedModel, TenantRequest } from "@/lib/gui/surface";
import { composeTenantApp } from "../compose";
import { buildTenantHomeModel } from "./home-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const TENANT_HOME_REFUSALS = {
  signedOut: { ok: false, status: 403, message: "Your session has ended. Sign in again to see your unit." },
  notFound: { ok: false, status: 404, message: "This unit could not be found." },
  disabled: { ok: false, status: 409, message: "The tenant app is not turned on for your unit yet." },
  failed: { ok: false, status: 500, message: "Your unit could not be loaded." },
  unavailable: { ok: false, status: 503, message: "Your unit could not be loaded right now. Try again shortly." },
} as const satisfies Record<string, Refusal>;

/**
 * A tenant app failure as this view's refusal. A 401 means the session ended
 * after the host checked it. A 400 or 403 means the unit is no longer the
 * caller's, which reads as not found, so a refusal never tells whether a
 * unit exists. A 409 is the plugin gate's: the tenant app is off for the
 * unit's organization.
 */
export function tenantHomeRefusal(failure: { status: number }): Refusal {
  const { status } = failure;
  if (status === 401) return TENANT_HOME_REFUSALS.signedOut;
  if (status === 409) return TENANT_HOME_REFUSALS.disabled;
  if (status >= 400 && status < 500) return TENANT_HOME_REFUSALS.notFound;
  if (status === 500) return TENANT_HOME_REFUSALS.failed;
  return TENANT_HOME_REFUSALS.unavailable;
}

export async function loadTenantHome(req: TenantRequest): Promise<Loaded<LoadedModel<"record">>> {
  const composed = await composeTenantApp({
    supabase: req.supabase,
    tenantId: req.tenantId,
    now: () => req.now.getTime(),
  });
  if (!composed.ok) return tenantHomeRefusal(composed);
  try {
    const home = await composed.data.tenantApp.getHome();
    if (!home.ok) return tenantHomeRefusal(home);
    return { ok: true, model: buildTenantHomeModel(home.data, req.fmt) };
  } finally {
    await composed.data.dispose();
  }
}
