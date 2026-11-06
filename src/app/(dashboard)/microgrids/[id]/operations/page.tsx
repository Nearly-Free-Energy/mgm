import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { DayPicker } from "@/components/operations/day-picker";
import { addDaysToDateKey, dayKeyInZone, isCalendarDateKey } from "@/lib/timezone/day-key";
import { isSupportedTimezone } from "@/lib/validation/timezone";
import { SiteDayLoading, SiteDaySection } from "./site-day-section";

/**
 * Daily operations: one local day of the site's battery, grid and supply.
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

  const timezone = isSupportedTimezone(microgrid.timezone) ? microgrid.timezone : "UTC";
  const today = dayKeyInZone(new Date(), timezone);
  const date =
    typeof requested === "string" && isCalendarDateKey(requested) && requested <= today
      ? requested
      : addDaysToDateKey(today, -1);

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
      </div>
    </>
  );
}
