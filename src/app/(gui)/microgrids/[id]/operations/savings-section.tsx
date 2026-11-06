import Link from "next/link";
import { Banner } from "@/components/ui/banner";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { SavingsTable } from "@/components/operations/savings-table";
import { createClient } from "@/lib/supabase/server";
import { composeMetering, type MeteringResult } from "@/lib/metering/compose";
import { SITE_DAYS_MAX } from "@/lib/metering/capability";
import type { SiteDayOperations } from "@/lib/metering/site-operations";
import {
  valueSiteDays,
  type SavingsSettingsInput,
  type TariffInput,
} from "@/lib/billing/site-savings";
import type { GridTariffBand } from "@/lib/types/domain";
import { addDaysToDateKey } from "@/lib/timezone/day-key";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The days to read for `date`: from the earlier of the savings start dates
 * and the 1st of the month, to `date`, cut to the last `SITE_DAYS_MAX` days.
 */
export function savingsReadRange(
  date: string,
  settings: SavingsSettingsInput
): { start: string; capped: boolean } {
  const monthStart = `${date.slice(0, 7)}-01`;
  const wanted = [settings.solar_savings_from, settings.arbitrage_from, monthStart]
    .filter((d): d is string => !!d)
    .sort()[0];
  const earliest = addDaysToDateKey(date, -(SITE_DAYS_MAX - 1));
  return wanted < earliest ? { start: earliest, capped: true } : { start: wanted, capped: false };
}

async function readSiteDays(
  supabase: SupabaseClient,
  organizationId: string,
  microgridId: string,
  start: string,
  end: string
): Promise<MeteringResult<SiteDayOperations[]>> {
  const composed = await composeMetering({ supabase, organizationId });
  if (!composed.ok) return composed;
  try {
    return await composed.data.metering.getSiteDays({
      microgrid_id: microgridId,
      start_date: start,
      end_date: end,
    });
  } finally {
    await composed.data.dispose();
  }
}

function SavingsSetupNote({ microgridId }: { microgridId: string }) {
  return (
    <EmptyState
      eyebrow="Savings"
      title="Count what the site saves"
      body="Enter the grid tariff (what the utility charges per kWh at each hour) and the day from which to count solar savings or arbitrage. This view then shows what the solar and the battery saved."
      cta={
        <Link
          href={`/microgrids/${microgridId}/setup/rates`}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
        >
          Go to Setup &gt; Rates
        </Link>
      }
    />
  );
}

/**
 * Money saved for the day, its month so far and since the savings start
 * dates. Rendered in its own Suspense boundary under the day's figures:
 * a range read takes up to one OpenEMS call per 31 days.
 */
export async function SavingsSection({
  organizationId,
  microgridId,
  date,
}: {
  organizationId: string;
  microgridId: string;
  date: string;
}) {
  const supabase = await createClient();

  // The user's own RLS client: both tables are FOR ALL on
  // user_can_access_microgrid, so this reads what the user may see.
  const [tariffsRes, settingsRes] = await Promise.all([
    supabase
      .from("grid_tariffs")
      .select("effective_from, bands")
      .eq("microgrid_id", microgridId)
      .order("effective_from", { ascending: true }),
    supabase
      .from("microgrid_savings_settings")
      .select("solar_savings_from, arbitrage_from, round_trip_efficiency")
      .eq("microgrid_id", microgridId)
      .maybeSingle(),
  ]);
  const readError = tariffsRes.error ?? settingsRes.error;
  if (readError) {
    return (
      <Banner tone="destructive" title="Could not load the savings settings">
        {readError.message}
      </Banner>
    );
  }

  const tariffs: TariffInput[] = (tariffsRes.data ?? []).map((t) => ({
    effective_from: t.effective_from,
    bands: t.bands as unknown as GridTariffBand[],
  }));
  const settings: SavingsSettingsInput | null = settingsRes.data
    ? {
        solar_savings_from: settingsRes.data.solar_savings_from,
        arbitrage_from: settingsRes.data.arbitrage_from,
        round_trip_efficiency: Number(settingsRes.data.round_trip_efficiency),
      }
    : null;

  if (
    !settings ||
    (!settings.solar_savings_from && !settings.arbitrage_from) ||
    tariffs.length === 0
  ) {
    return <SavingsSetupNote microgridId={microgridId} />;
  }

  const { start, capped } = savingsReadRange(date, settings);
  const result = await readSiteDays(supabase, organizationId, microgridId, start, date);

  if (!result.ok) {
    // SiteDaySection, above this one on the page, already explains both of
    // these (the setup EmptyState and the "Metering is disabled" banner);
    // saying it twice is noise. If that section stops showing them, revisit.
    if (result.code === "metering_no_site_devices" || result.status === 409) return null;
    return (
      <Banner tone="destructive" title="Could not work out the savings">
        {result.message}
      </Banner>
    );
  }

  const summary = valueSiteDays({ days: result.data, tariffs, settings, date });
  // Only the summary reaches the client component; the days and their
  // per-bin flows stay on the server.
  return (
    <SavingsTable
      summary={summary}
      date={date}
      solarFrom={settings.solar_savings_from}
      arbitrageFrom={settings.arbitrage_from}
      cappedFrom={capped ? start : null}
      solarEstimated={result.data.some((d) => d.solarEstimated)}
    />
  );
}

export function SavingsLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the savings">
      <span className="sr-only">Loading the savings…</span>
      <LoadingSkeleton className="h-[220px] rounded-lg" />
    </div>
  );
}
