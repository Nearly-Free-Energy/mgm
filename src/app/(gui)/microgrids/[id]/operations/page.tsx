import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { DayPicker } from "@/components/operations/day-picker";
import { resolveRequestedDay } from "@/lib/timezone/requested-day";
import { SiteDayLoading, SiteDaySection } from "./site-day-section";
import { SavingsLoading, SavingsSection } from "./savings-section";

/**
 * Daily operations: one local day of the site's battery, grid and supply,
 * and below it what the solar and battery saved against the grid tariff.
 *
 * Reads through the metering capability (composeMetering), not a direct
 * OpenEMS client: the capability checks the session and the organization,
 * refuses while Metering is disabled, and its provider finds the OpenEMS
 * connection the same way billing does — including the pilot's
 * environment-configured backend, which a direct client cannot see.
 */
export default async function OperationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ date?: string | string[] }>;
}) {
  const { id } = await params;
  const requested = (await searchParams)?.date;
  const supabase = await createClient();

  const [levels, { data: microgrid }] = await Promise.all([
    getHierarchyLevels(supabase, { kind: "microgrid", microgridId: id }),
    supabase
      .from("microgrids")
      .select("id, timezone, communities!inner(org_id)")
      .eq("id", id)
      .maybeSingle<{ id: string; timezone: string; communities: { org_id: string } }>(),
  ]);
  if (!microgrid) notFound();

  const { today, date } = resolveRequestedDay({
    requested,
    stored: microgrid.timezone,
    now: new Date(),
  });

  return (
    <>
      <HierarchyNav levels={levels} className="mb-4" />
      <div className="space-y-4">
        <DayPicker basePath={`/microgrids/${id}/operations`} date={date} today={today} />
        <Suspense key={date} fallback={<SiteDayLoading />}>
          <SiteDaySection
            organizationId={microgrid.communities.org_id}
            microgridId={id}
            date={date}
          />
        </Suspense>
        {/* Its own boundary: a range read is slower than the day's, and the
            day should not wait for it. */}
        <Suspense key={`savings-${date}`} fallback={<SavingsLoading />}>
          <SavingsSection
            organizationId={microgrid.communities.org_id}
            microgridId={id}
            date={date}
          />
        </Suspense>
      </div>
    </>
  );
}
