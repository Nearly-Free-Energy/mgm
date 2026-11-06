import Link from "next/link";
import { Banner } from "@/components/ui/banner";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { DailyOperations } from "@/components/operations/daily-operations";
import { createClient } from "@/lib/supabase/server";
import { composeMetering, type MeteringResult } from "@/lib/metering/compose";
import type { SiteDayOperations, SiteDaySummary } from "@/lib/metering/site-operations";

async function readSiteDay(
  organizationId: string,
  microgridId: string,
  date: string
): Promise<MeteringResult<SiteDayOperations>> {
  const supabase = await createClient();
  const composed = await composeMetering({ supabase, organizationId });
  if (!composed.ok) return composed;
  try {
    return await composed.data.metering.getSiteDay({ microgrid_id: microgridId, date });
  } finally {
    await composed.data.dispose();
  }
}

/** The day without its per-bin flows, which only the server needs. */
export function withoutFlows(day: SiteDayOperations): SiteDaySummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { flows, ...rest } = day;
  return rest;
}

/**
 * One day's figures. Rendered inside a Suspense boundary keyed on the day,
 * so changing day shows the placeholder at once while OpenEMS answers.
 */
export async function SiteDaySection({
  organizationId,
  microgridId,
  date,
}: {
  organizationId: string;
  microgridId: string;
  date: string;
}) {
  const result = await readSiteDay(organizationId, microgridId, date);
  if (result.ok) return <DailyOperations day={withoutFlows(result.data)} />;
  if (result.code === "metering_no_site_devices") {
    return (
      <EmptyState
        title="Register the battery and grid meter"
        body="This view reads the site's battery and grid meter from OpenEMS. Discover them on the microgrid's edge and set their types to Battery and Grid meter. For a solar estimate, also set the meter on the inverter's output to Inverter."
        cta={
          <Link
            href={`/microgrids/${microgridId}/setup/edges`}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            Go to Edges
          </Link>
        }
      />
    );
  }
  // The synthetic provider refuses a microgrid with both synthetic and real
  // edges with this 409 (src/lib/metering/fixture/plugin.ts), the only 409
  // METERING_CONFIGURATION getSiteDay returns. If that code or status
  // changes, or another source returns it, change this branch.
  if (result.status === 409 && result.code === "METERING_CONFIGURATION") {
    return (
      <Banner
        tone="warn"
        title="Synthetic and real edges are mixed"
        action={
          <Link
            href={`/microgrids/${microgridId}/setup/edges`}
            className="text-sm font-medium text-primary hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            Go to Edges →
          </Link>
        }
      >
        {result.message}
      </Banner>
    );
  }
  if (result.status === 409) {
    return (
      <Banner tone="warn" title="Metering is disabled">
        {result.message}
      </Banner>
    );
  }
  // Each failure ends with something to do. A configuration error means the
  // microgrid has no usable OpenEMS connection, which anyone who can open
  // this page may set up (#321); anything else is worth another try.
  const configuration = result.code === "METERING_CONFIGURATION";
  return (
    <Banner
      tone="destructive"
      title="Could not load this day's operations"
      action={
        configuration ? (
          <Link
            href={`/microgrids/${microgridId}/setup/openems-backend`}
            className="text-sm font-medium text-primary hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            Set up the OpenEMS connection →
          </Link>
        ) : (
          // A full page load, so the day is read again rather than served
          // from the router's cache.
          <a
            href={`/microgrids/${microgridId}/operations?date=${encodeURIComponent(date)}`}
            className="text-sm font-medium text-primary hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            Try again
          </a>
        )
      }
    >
      {result.message}
    </Banner>
  );
}

export function SiteDayLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the day's operations" className="space-y-4">
      <span className="sr-only">Loading the day&apos;s operations…</span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <LoadingSkeleton key={i} className="h-[84px] rounded-lg" />
        ))}
      </div>
      <LoadingSkeleton className="h-[280px] rounded-lg" />
      <LoadingSkeleton className="h-[110px] rounded-lg" />
    </div>
  );
}
