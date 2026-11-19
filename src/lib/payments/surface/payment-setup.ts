import "server-only";

/**
 * The loader of the `payments.payment-setup` view (./payment-setup-model.ts):
 * whether the microgrid's community can take online payments, shown as a
 * section of billing's send queue.
 *
 * The period and the microgrid are read through the person's own client
 * (row-level security): billing_periods and microgrids are FOR ALL on
 * user_can_access_microgrid; if their policies change, revisit what this
 * shows. The period is read only to refuse one under another microgrid, as
 * the send queue does.
 *
 * The readiness is the Payments capability's getReadiness for the
 * microgrid's community (a read listed in gui-surface.test.ts's
 * LOADER_READS), composed with composePayments, which checks the session
 * with getUser and the person's access to the organization; it reads the
 * merchant account's public columns and the plugin states through the same
 * client, and decrypts nothing. A readiness that cannot be read shows as
 * not checked; it never refuses the view. Composing on req.supabase queues
 * that client's other queries behind getUser's auth lock (the legacy period
 * page's note on paymentLinkAvailable), so it runs after the view's own
 * reads.
 *
 * The view loads while Payments is off, and the host shows the gate's
 * notice. A refusal carries fixed copy, never a database message.
 */
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { rolesIncludeSuperAdmin } from "@/lib/auth/access";
import { microgridPublicColumns } from "@/lib/types/microgrid-columns";
import { composePayments } from "../compose";
import { buildPaymentSetupModel, SETUP_READINESS, type SetupReadiness } from "./payment-setup-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const PAYMENT_SETUP_REFUSALS = {
  notFound: { ok: false, status: 404, message: "This billing period could not be found." },
  unavailable: { ok: false, status: 503, message: "Could not load this community's payment setup right now. Try again shortly." },
} as const satisfies Record<string, Refusal>;

/** The community's payment readiness, or "unchecked" when it cannot be read. */
async function readReadiness(req: SurfaceRequest, communityId: string): Promise<SetupReadiness> {
  try {
    const composed = await composePayments({ supabase: req.supabase, organizationId: req.organizationId, allowDisabled: true });
    if (!composed.ok) return "unchecked";
    try {
      const readiness = await composed.data.payments.getReadiness(communityId);
      if (!readiness.ok) return "unchecked";
      return SETUP_READINESS.includes(readiness.data.state) ? readiness.data.state : "unchecked";
    } finally {
      await composed.data.dispose();
    }
  } catch {
    return "unchecked";
  }
}

export async function loadPaymentSetup(req: SurfaceRequest): Promise<Loaded<LoadedModel<"record">>> {
  const microgridId = req.params.id;
  const [periodRes, microgridRes] = await Promise.all([
    req.supabase.from("billing_periods").select("id").eq("id", req.params.periodId).eq("microgrid_id", microgridId).maybeSingle<{ id: string }>(),
    req.supabase.from("microgrids").select(microgridPublicColumns("id", "community_id")).eq("id", microgridId).maybeSingle<{ id: string; community_id: string }>(),
  ]);
  if (periodRes.error || microgridRes.error) return PAYMENT_SETUP_REFUSALS.unavailable;
  if (!periodRes.data || !microgridRes.data) return PAYMENT_SETUP_REFUSALS.notFound;
  const communityId = microgridRes.data.community_id;

  return {
    ok: true,
    model: buildPaymentSetupModel({
      communityId,
      readiness: await readReadiness(req, communityId),
      superAdmin: rolesIncludeSuperAdmin(req.roles),
      fmt: req.fmt,
    }),
  };
}
