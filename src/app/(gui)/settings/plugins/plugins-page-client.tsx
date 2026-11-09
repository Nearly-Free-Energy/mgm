"use client";

import * as React from "react";

type PluginView = {
  name: string;
  displayName: string;
  description: string;
  version: string;
  enabled: boolean;
  core: boolean;
  dependencies: string[];
  disabledDependencies: string[];
  ready: boolean;
  provides: string[];
};

type AuditView = {
  id: string;
  plugin_name: string;
  action: string;
  previous_enabled: boolean | null;
  new_enabled: boolean;
  actor_user_id: string | null;
  created_at: string;
};

export type PluginsOrgView = {
  id: string;
  name: string;
  plugins: PluginView[];
  audit: AuditView[];
};

function dependencyLabel(name: string, plugins: PluginView[]): string {
  return plugins.find((plugin) => plugin.name === name)?.displayName ?? name;
}

export function PluginsPageClient({ orgs }: { orgs: PluginsOrgView[] }) {
  const [sections, setSections] = React.useState(orgs);
  const [pending, setPending] = React.useState<string | null>(null);
  const [errorByOrg, setErrorByOrg] = React.useState<Record<string, string>>({});

  async function refreshOrg(orgId: string) {
    const res = await fetch(`/api/organizations/${orgId}/plugins`, {
      method: "GET",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Could not reload plugin settings.");
    }
    const body = (await res.json()) as {
      plugins: PluginView[];
      audit: AuditView[];
    };
    setSections((prev) =>
      prev.map((section) =>
        section.id === orgId
          ? { ...section, plugins: body.plugins, audit: body.audit }
          : section
      )
    );
  }

  async function toggle(orgId: string, pluginName: string, enabled: boolean) {
    const key = `${orgId}:${pluginName}`;
    setPending(key);
    setErrorByOrg((prev) => ({ ...prev, [orgId]: "" }));
    try {
      const res = await fetch(`/api/organizations/${orgId}/plugins`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugin: pluginName, enabled }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not update the plugin.");
      }
      await refreshOrg(orgId);
    } catch (error) {
      setErrorByOrg((prev) => ({
        ...prev,
        [orgId]: error instanceof Error ? error.message : "Could not update the plugin.",
      }));
    } finally {
      setPending(null);
    }
  }

  if (sections.length === 0) {
    return (
      <div className="rounded-md border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">
          No organizations visible. Create an organization first, then manage
          its plugins here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {sections.map((org) => (
        <section
          key={org.id}
          aria-labelledby={`plugins-org-${org.id}`}
          className="rounded-lg border border-border bg-card p-6"
        >
          <h2
            id={`plugins-org-${org.id}`}
            className="text-lg font-semibold text-foreground"
          >
            {org.name}
          </h2>
          {errorByOrg[org.id] ? (
            <div
              role="alert"
              className="mt-4 rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg"
            >
              {errorByOrg[org.id]}
            </div>
          ) : null}
          <ul className="mt-4 space-y-4">
            {org.plugins.map((plugin) => {
              const key = `${org.id}:${plugin.name}`;
              const busy = pending === key;
              return (
                <li
                  key={plugin.name}
                  className="rounded-md border border-border bg-muted p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="font-medium text-foreground">
                        {plugin.displayName}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {plugin.description}
                      </p>
                      <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
                        <div className="flex gap-2">
                          <dt className="font-medium">Version</dt>
                          <dd>{plugin.version}</dd>
                        </div>
                        <div className="flex gap-2">
                          <dt className="font-medium">State</dt>
                          <dd>{plugin.enabled ? "Enabled" : "Disabled"}</dd>
                        </div>
                        <div className="flex gap-2">
                          <dt className="font-medium">Depends on</dt>
                          <dd>
                            {plugin.dependencies.length === 0
                              ? "None"
                              : plugin.dependencies
                                  .map((name) => dependencyLabel(name, org.plugins))
                                  .join(", ")}
                          </dd>
                        </div>
                        <div className="flex gap-2">
                          <dt className="font-medium">Readiness</dt>
                          <dd>{plugin.ready ? "Ready" : "Not ready"}</dd>
                        </div>
                      </dl>
                      {!plugin.ready && plugin.disabledDependencies.length > 0 ? (
                        <p className="mt-2 rounded-md bg-warning-muted p-2 text-xs text-warning-fg">
                          Waiting on{" "}
                          {plugin.disabledDependencies
                            .map((name) => dependencyLabel(name, org.plugins))
                            .join(", ")}
                          .
                        </p>
                      ) : null}
                      {!plugin.enabled ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Disabled plugins keep existing records; community,
                          microgrid, and household writes fail closed until the
                          plugin is re-enabled.
                        </p>
                      ) : null}
                    </div>
                    {plugin.core ? (
                      <span className="rounded-md bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">
                        Core — always enabled
                      </span>
                    ) : (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={plugin.enabled}
                        aria-label={`${plugin.displayName} for ${org.name}`}
                        disabled={busy}
                        onClick={() => toggle(org.id, plugin.name, !plugin.enabled)}
                        className="rounded-md bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy
                          ? "Saving…"
                          : plugin.enabled
                            ? "Disable"
                            : "Enable"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {org.audit.length > 0 ? (
            <div className="mt-6">
              <h3 className="text-sm font-medium text-foreground">
                Recent plugin changes
              </h3>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {org.audit.map((entry) => (
                  <li key={entry.id}>
                    {dependencyLabel(entry.plugin_name, org.plugins)} was{" "}
                    {entry.action} —{" "}
                    {entry.previous_enabled === null
                      ? "no previous state"
                      : entry.previous_enabled
                        ? "was enabled"
                        : "was disabled"}
                    .
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
