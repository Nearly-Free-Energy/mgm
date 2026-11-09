import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { rolesIncludeSuperAdmin } from "@/lib/auth/access";
import { getRequestUserAccess } from "@/lib/auth/request-access";
import { COMMUNITY_MANAGEMENT_PLUGIN_NAME } from "@/lib/plugins/bundled";
import { SidebarNavLinks } from "./sidebar-nav-links";
import type { SidebarEntry } from "./sidebar-nav-links";

/**
 * The organizations and community-management plugin rows SidebarNav reads,
 * once per render. RLS scopes both to what the caller can see.
 */
const readNavigationState = cache(async () => {
  const supabase = await createClient();
  return Promise.all([
    supabase.from("organizations").select("id"),
    supabase
      .from("mgm_plugins")
      .select("org_id, enabled")
      .eq("plugin_name", COMMUNITY_MANAGEMENT_PLUGIN_NAME),
  ]);
});

/**
 * Starts SidebarNav's reads ahead of its render. The (gui) layout calls
 * this before its own awaited checks, because SidebarNav, rendered inside the
 * layout's output, cannot start until the layout returns; if that stops being
 * true, the preload buys nothing. A failure surfaces when SidebarNav awaits
 * the same read.
 */
export function preloadSidebarNav(): void {
  readNavigationState().catch(() => {});
}

/**
 * SidebarNav — dashboard sidebar navigation (#76, #97).
 *
 * Server component: resolves the user's super_admin status via the auth
 * access module, builds a pre-filtered entries array, and delegates
 * rendering (including active-state via usePathname) to SidebarNavLinks.
 *
 * The Organizations entry is omitted from the entries array when the user is
 * not a super_admin — role gating stays entirely server-side so a tampered
 * client cannot reveal hidden links by inspecting the DOM.
 *
 * Community management entries (Communities, Microgrids) are omitted only
 * when every organization the caller can access has explicitly disabled the
 * community-management plugin (Release 1, issue #3). A missing plugin row
 * means "enabled", so fresh and existing deployments keep their navigation
 * until an operator opts out per organization.
 *
 * Settings links to /settings/profile (lands the user on a real page) but
 * uses matchPrefix="/settings" so any /settings/* route keeps it highlighted.
 */
export async function SidebarNav() {
  const [{ roles }, [{ data: orgs }, { data: pluginStates }]] =
    await Promise.all([getRequestUserAccess(), readNavigationState()]);
  const isSuperAdmin = rolesIncludeSuperAdmin(roles);

  const orgIds = (orgs ?? []).map((org) => org.id as string);
  const disabledOrgIds = new Set(
    (pluginStates ?? [])
      .filter((row) => row.enabled === false)
      .map((row) => row.org_id as string)
  );
  const communityManagementEnabled =
    orgIds.length === 0 ||
    orgIds.some((orgId) => !disabledOrgIds.has(orgId));

  const entries: SidebarEntry[] = [
    { label: "Dashboard", href: "/", matchPrefix: "/", exact: true },
    ...(isSuperAdmin
      ? [
          {
            label: "Organizations",
            href: "/organizations",
            matchPrefix: "/organizations",
          } satisfies SidebarEntry,
        ]
      : []),
    ...(communityManagementEnabled
      ? [
          {
            label: "Communities",
            href: "/communities",
            matchPrefix: "/communities",
          } satisfies SidebarEntry,
          {
            label: "Microgrids",
            href: "/microgrids",
            matchPrefix: "/microgrids",
          } satisfies SidebarEntry,
        ]
      : []),
    {
      label: "Settings",
      href: "/settings/profile",
      matchPrefix: "/settings",
    },
  ];

  return <SidebarNavLinks entries={entries} />;
}
