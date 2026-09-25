import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import type { Organization, Microgrid } from "@/lib/types/domain";
import { COMMUNITY_MANAGEMENT_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { getCurrentUserRoles } from "@/lib/auth/access";
import { SUPER_ADMIN } from "@/lib/roles";

type MicrogridWithHouseholdCount = {
  id: string;
  name: string;
  address_city: string | null;
  address_country: string | null;
  currency: string;
  household_count: number;
};

export default async function DashboardPage() {
  const supabase = await createClient();

  const [
    { data: organizations, error: orgError },
    { data: pluginStates },
    roles,
  ] = await Promise.all([
    supabase.from("organizations").select("*").returns<Organization[]>(),
    supabase
      .from("mgm_plugins")
      .select("org_id, enabled")
      .eq("plugin_name", COMMUNITY_MANAGEMENT_PLUGIN_NAME),
    getCurrentUserRoles(supabase),
  ]);

  if (orgError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading organizations: {orgError.message}
      </div>
    );
  }

  const disabledOrgIds = new Set(
    (pluginStates ?? [])
      .filter((row) => row.enabled === false)
      .map((row) => row.org_id as string)
  );
  const isSuperAdmin = roles.some((role) => role.role === SUPER_ADMIN);

  if (!organizations || organizations.length === 0) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-semibold text-foreground">
          Dashboard
        </h1>
        <div className="rounded-md border border-border bg-card p-8 text-center text-muted-foreground">
          No organizations found. You may need to run the database migrations
          and seed data, or your account may not have the required permissions.
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-foreground">Dashboard</h1>
      <nav
        aria-label="Setup"
        className="mb-6 flex flex-wrap gap-2 text-sm"
      >
        {isSuperAdmin ? (
          <Link
            href="/organizations"
            className="rounded-md border border-border bg-card px-3 py-1.5 text-foreground hover:bg-muted"
          >
            + Organization
          </Link>
        ) : null}
        <Link
          href="/communities"
          className="rounded-md border border-border bg-card px-3 py-1.5 text-foreground hover:bg-muted"
        >
          Communities
        </Link>
        <Link
          href="/microgrids"
          className="rounded-md border border-border bg-card px-3 py-1.5 text-foreground hover:bg-muted"
        >
          Microgrids
        </Link>
        <Link
          href="/settings/plugins"
          className="rounded-md border border-border bg-card px-3 py-1.5 text-foreground hover:bg-muted"
        >
          Plugin settings
        </Link>
      </nav>
      <div className="space-y-6">
        {organizations.map((org) => (
          <OrgCard
            key={org.id}
            org={org}
            communityManagementEnabled={!disabledOrgIds.has(org.id)}
          />
        ))}
      </div>
    </div>
  );
}

export async function OrgCard({
  org,
  communityManagementEnabled = true,
}: {
  org: Organization;
  communityManagementEnabled?: boolean;
}) {
  const supabase = await createClient();

  if (!communityManagementEnabled) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <h2 className="mb-2 text-lg font-semibold text-foreground">
          {org.name}
        </h2>
        <p className="text-sm text-muted-foreground">
          Community management is disabled for this organization. Existing
          records are preserved.{" "}
          <Link href="/settings/plugins" className="text-primary hover:underline">
            Enable it in plugin settings
          </Link>{" "}
          to manage communities, microgrids, and households.
        </p>
      </div>
    );
  }

  // Fetch microgrids for this org (via communities join)
  const { data: microgrids } = await supabase
    .from("microgrids")
    .select("id, name, address_city, address_country, currency, community_id, communities!inner(org_id)")
    .eq("communities.org_id", org.id);

  // For each microgrid, get household count
  const microgridsWithCounts: MicrogridWithHouseholdCount[] = [];
  if (microgrids) {
    for (const mg of microgrids as unknown as Microgrid[]) {
      const { count } = await supabase
        .from("households")
        .select("*", { count: "exact", head: true })
        .eq("microgrid_id", mg.id);

      microgridsWithCounts.push({
        id: mg.id,
        name: mg.name,
        address_city: mg.address_city,
        address_country: mg.address_country,
        currency: mg.currency,
        household_count: count ?? 0,
      });
    }
  }

  const locationLabel = (mg: MicrogridWithHouseholdCount) => {
    const parts = [mg.address_city, mg.address_country].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  };

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold text-foreground">{org.name}</h2>
      {microgridsWithCounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No microgrids configured.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {microgridsWithCounts.map((mg) => (
            <Link
              key={mg.id}
              href={`/microgrids/${mg.id}`}
              className="block rounded-md border border-border bg-muted p-4 transition-colors hover:bg-card hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <h3 className="font-medium text-foreground">{mg.name}</h3>
              {locationLabel(mg) && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {locationLabel(mg)}
                </p>
              )}
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {mg.household_count} household{mg.household_count !== 1 ? "s" : ""}
                </span>
                <span className="text-muted-foreground">{mg.currency}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
