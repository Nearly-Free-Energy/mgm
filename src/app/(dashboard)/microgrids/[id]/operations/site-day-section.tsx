import Link from "next/link";
import { Banner } from "@/components/ui/banner";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { DailyOperations } from "@/components/operations/daily-operations";
import { createClient } from "@/lib/supabase/server";
import { composeMetering, type MeteringResult } from "@/lib/metering/compose";
import type { SiteDayOperations } from "@/lib/metering/site-operations";

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
  if (result.ok) return <DailyOperations day={result.data} />;
  if (result.code === "metering_no_site_devices") {
    return (
      <EmptyState
        title="Register the battery and grid meter"
        body="This view reads the site's battery and grid meter from OpenEMS. Discover them on the microgrid's edge and set their types to Battery and Grid meter. For a solar estimate, also set the meter on the inverter's output to Inverter."
        cta={
          <Link
            href={`/microgrids/${microgridId}/setup/edges`}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            Go to Edges
          </Link>
        }
      />
    );
  }
  return (
    <Banner
      tone={result.status === 409 ? "warn" : "destructive"}
      title={
        result.status === 409 ? "Metering is disabled" : "Could not load this day's operations"
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
