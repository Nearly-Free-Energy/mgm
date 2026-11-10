import "server-only";

/**
 * The loader of the `metering.site-day` view: one local day of a microgrid's
 * battery, grid and supply, read through the metering capability for the
 * request's organization, as the Operations page reads it.
 *
 * A refusal carries fixed copy chosen by its status and code, never the
 * capability's message, which can carry text from an outside system.
 */
import type { LinkRef } from "@/lib/gui/contract";
import type { Loaded, LoadedModel, SurfaceRequest } from "@/lib/gui/surface";
import { resolveRequestedDay } from "@/lib/timezone/requested-day";
import { composeMetering } from "../compose";
import { buildNoSiteDevicesModel, buildSiteDayModel } from "./site-day-model";

type Refusal = Extract<Loaded<never>, { ok: false }>;

export const SITE_DAY_REFUSALS = {
  forbidden: { ok: false, status: 403, message: "You do not have access to this microgrid's operations." },
  notFound: { ok: false, status: 404, message: "This microgrid could not be found." },
  disabled: {
    ok: false,
    status: 409,
    message: "Metering is disabled for this organization. Enable it in Settings → Plugins.",
  },
  mixed: {
    ok: false,
    status: 409,
    message: "This microgrid mixes synthetic and real edges; keep synthetic data in its own microgrid.",
  },
  failed: { ok: false, status: 500, message: "This day's operations could not be loaded." },
  noConnection: {
    ok: false,
    status: 503,
    message: "This microgrid has no usable OpenEMS connection. Set it up under Setup → OpenEMS Backend.",
  },
  rejected: {
    ok: false,
    status: 503,
    message: "OpenEMS did not accept this microgrid's connection settings. Check them under Setup → OpenEMS Backend.",
  },
  unavailable: { ok: false, status: 503, message: "This day's operations could not be loaded right now. Try again shortly." },
} as const satisfies Record<string, Refusal>;

/**
 * A capability failure as this view's refusal. The metering source's codes
 * come first, since its 401 or 403 is OpenEMS refusing the stored settings,
 * not the person. Otherwise a 401 means the session ended after the host
 * checked it, so it reads as 403, and any other 4xx reads as 404.
 */
export function siteDayRefusal(failure: { status: number; code: string }): Refusal {
  const { status, code } = failure;
  if (code === "metering_disabled") return SITE_DAY_REFUSALS.disabled;
  // The synthetic provider's refusal of a microgrid with synthetic and real
  // edges (src/lib/metering/fixture/plugin.ts); if its status or code changes, revisit.
  if (code === "METERING_CONFIGURATION") return status === 409 ? SITE_DAY_REFUSALS.mixed : SITE_DAY_REFUSALS.noConnection;
  if (code === "METERING_UNAUTHORIZED") return SITE_DAY_REFUSALS.rejected;
  if (code.startsWith("METERING_")) return SITE_DAY_REFUSALS.unavailable;
  if (status === 401 || status === 403) return SITE_DAY_REFUSALS.forbidden;
  if (status >= 400 && status < 500) return SITE_DAY_REFUSALS.notFound;
  if (status === 500) return SITE_DAY_REFUSALS.failed;
  return SITE_DAY_REFUSALS.unavailable;
}

/**
 * The day's link to a page that holds the microgrid's Edit button and time
 * zone nudge: the legacy microgrid layout (src/app/(gui)/microgrids/[id]/layout.tsx)
 * shows both above Setup → Edges. If they move off that layout, revisit.
 * The setup state needs none, since its Edges link goes to the same page.
 */
export function withSetupLink(model: LoadedModel<"metrics">, microgridId: string): LoadedModel<"metrics"> {
  const link: LinkRef = {
    id: "metering.microgrid-setup",
    label: "Microgrid setup",
    href: `/microgrids/${encodeURIComponent(microgridId)}/setup/edges`,
  };
  return { ...model, links: [...(model.links ?? []), link] };
}

export async function loadSiteDay(req: SurfaceRequest): Promise<Loaded<LoadedModel<"metrics">>> {
  // Through row-level security. The host resolved this microgrid to
  // req.organizationId first (resolveSegments in dispatchView), and getSiteDay
  // checks the organization again; if both stop doing so, revisit.
  const { data: microgrid, error } = await req.supabase
    .from("microgrids")
    .select("id, name, timezone")
    .eq("id", req.params.id)
    .maybeSingle<{ id: string; name: string; timezone: string | null }>();
  if (error) return SITE_DAY_REFUSALS.unavailable;
  if (!microgrid) return SITE_DAY_REFUSALS.notFound;

  const { timezone, today, date } = resolveRequestedDay({
    requested: req.search.getAll("date"),
    stored: microgrid.timezone,
    now: req.now,
  });
  const composed = await composeMetering({ supabase: req.supabase, organizationId: req.organizationId });
  if (!composed.ok) return siteDayRefusal(composed);
  try {
    const day = await composed.data.metering.getSiteDay({ microgrid_id: microgrid.id, date });
    if (day.ok) {
      const model = buildSiteDayModel(day.data, { microgrid, today, locale: req.locale, fmt: req.fmt });
      return { ok: true, model: withSetupLink(model, microgrid.id) };
    }
    if (day.code === "metering_no_site_devices") {
      return {
        ok: true,
        model: buildNoSiteDevicesModel({ microgrid, date, today, timezone, locale: req.locale, fmt: req.fmt }),
      };
    }
    return siteDayRefusal(day);
  } finally {
    await composed.data.dispose();
  }
}
