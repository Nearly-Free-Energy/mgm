import { createClient } from "@/lib/supabase/server";
import {
  listOrganizationPlugins,
  listOrganizationPluginAudit,
} from "@/lib/plugins/state";
import {
  PluginsPageClient,
  type PluginsOrgView,
} from "./plugins-page-client";

/**
 * /settings/plugins — organization plugin management (Release 1, issue #3).
 *
 * Server component: organization state is resolved through RLS-scoped reads
 * plus the plugin service's explicit access checks. Toggling happens through
 * PATCH /api/organizations/[id]/plugins, which validates bundled-plugin
 * identity, dependency order, and records every change in audit history.
 */
export default async function SettingsPluginsPage() {
  const supabase = await createClient();
  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name")
    .order("name", { ascending: true });

  const sections: PluginsOrgView[] = [];
  for (const org of orgs ?? []) {
    try {
      const [plugins, audit] = await Promise.all([
        listOrganizationPlugins(supabase, org.id),
        listOrganizationPluginAudit(supabase, org.id, 20),
      ]);
      sections.push({
        id: org.id,
        name: org.name,
        plugins: plugins.map((status) => ({
          name: status.plugin.name,
          displayName: status.plugin.displayName,
          description: status.plugin.description,
          version: status.version,
          enabled: status.enabled,
          core: status.plugin.core,
          dependencies: [...status.plugin.dependencies],
          disabledDependencies: [...status.disabledDependencies],
          ready: status.ready,
          provides: [...status.plugin.provides],
        })),
        audit: audit.map((entry) => ({ ...entry })),
      });
    } catch {
      // Organization access is enforced inside the service. Skip orgs the
      // caller cannot manage rather than failing the whole settings page.
    }
  }

  return <PluginsPageClient orgs={sections} />;
}
