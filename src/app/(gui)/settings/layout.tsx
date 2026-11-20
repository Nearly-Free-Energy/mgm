import { keepTenantOnlyToTenantPages } from "@/lib/gui/host/server/tenant-pages";
import { SettingsSubNav } from "./settings-subnav";

/**
 * /settings layout — Profile + Users sub-nav (UX5 / #79).
 *
 * The sub-nav is a tablist; `id="settings-panel"` on the content region
 * ties aria-controls from each tab to a single landmark (matching the
 * setup-subnav pattern).
 */
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // As every (gui) page and layout does first: a nested layout renders
  // alongside the page on a client-side navigation (mgm#209), so it must
  // not depend on the page's own call, even before a read is added here.
  await keepTenantOnlyToTenantPages();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your profile, organization members, and organization plugins.
        </p>
      </div>
      <SettingsSubNav />
      <div id="settings-panel" role="tabpanel">
        {children}
      </div>
    </div>
  );
}
