import { createClient } from "@/lib/supabase/server";
import type { GridTariff, MicrogridSavingsSettings, RateSchedule } from "@/lib/types/domain";
import { TierEditor } from "@/components/TierEditor";
import { GridTariffEditor } from "@/components/GridTariffEditor";
import { dayKeyInZone } from "@/lib/timezone/day-key";
import { isSupportedTimezone } from "@/lib/validation/timezone";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";

export default async function RatesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [canManage, levels] = await Promise.all([
    currentUserCanAccessMicrogrid(supabase, id),
    getHierarchyLevels(supabase, {
      kind: "microgrid",
      microgridId: id,
    }),
  ]);

  const [
    { data: schedule, error: scheduleError },
    { data: microgrid, error: microgridError },
    { data: gridTariffs, error: gridTariffsError },
    { data: savingsSettings, error: savingsSettingsError },
  ] = await Promise.all([
      supabase
        .from("rate_schedules")
        .select("*")
        .eq("microgrid_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
        .then((res) => ({ ...res, data: res.data as RateSchedule | null })),
      supabase
        .from("microgrids")
        .select("id, name, currency, timezone")
        .eq("id", id)
        .single(),
      // Read through the user's RLS client: both tables are FOR ALL on
      // user_can_access_microgrid, so a reader sees exactly what they may.
      supabase
        .from("grid_tariffs")
        .select("id, microgrid_id, effective_from, bands, created_at")
        .eq("microgrid_id", id)
        .order("effective_from", { ascending: false })
        .then((res) => ({ ...res, data: (res.data ?? []) as GridTariff[] })),
      supabase
        .from("microgrid_savings_settings")
        .select("microgrid_id, solar_savings_from, arbitrage_from, round_trip_efficiency, updated_at")
        .eq("microgrid_id", id)
        .maybeSingle()
        .then((res) => ({
          ...res,
          data: res.data
            ? ({
                ...res.data,
                round_trip_efficiency: Number(res.data.round_trip_efficiency),
              } as MicrogridSavingsSettings)
            : null,
        })),
    ]);

  if (microgridError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading microgrid: {microgridError.message}
      </div>
    );
  }

  if (scheduleError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading rate schedule: {scheduleError.message}
      </div>
    );
  }

  const timezone = isSupportedTimezone(microgrid.timezone) ? microgrid.timezone : "UTC";

  return (
    <>
      <HierarchyNav levels={levels} className="mb-4" />
      <TierEditor
        microgridId={id}
        currency={microgrid.currency}
        initialSchedule={schedule}
        canManage={canManage}
      />
      <section aria-labelledby="grid-tariff-heading" className="mt-8 space-y-4">
        <h2 id="grid-tariff-heading" className="text-lg font-semibold text-foreground">
          Grid tariff (what the microgrid pays the utility)
        </h2>
        {gridTariffsError || savingsSettingsError ? (
          <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
            Error loading the grid tariff: {(gridTariffsError ?? savingsSettingsError)!.message}
          </div>
        ) : (
          <GridTariffEditor
            microgridId={id}
            currency={microgrid.currency}
            tariffs={gridTariffs}
            settings={savingsSettings}
            today={dayKeyInZone(new Date(), timezone)}
            canManage={canManage}
          />
        )}
      </section>
    </>
  );
}
