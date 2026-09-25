import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";
import { PluginsPageClient } from "../plugins-page-client";

describe("PluginsPageClient", () => {
  it("renders versions, dependencies, readiness, and audit history", () => {
    const html = renderToStaticMarkup(
      (
        <PluginsPageClient
          orgs={[
            {
              id: "org-1",
              name: "Acme Energy",
              plugins: [
                {
                  name: "organization-directory",
                  displayName: "Organization directory",
                  description: "org stuff",
                  version: "0.1.0",
                  enabled: true,
                  core: true,
                  dependencies: [],
                  disabledDependencies: [],
                  ready: true,
                  provides: [],
                },
                {
                  name: "community-management",
                  displayName: "Community management",
                  description: "community stuff",
                  version: "0.1.0",
                  enabled: false,
                  core: false,
                  dependencies: ["organization-directory"],
                  disabledDependencies: [],
                  ready: true,
                  provides: [],
                },
              ],
              audit: [
                {
                  id: "audit-1",
                  plugin_name: "community-management",
                  action: "disabled",
                  previous_enabled: true,
                  new_enabled: false,
                  actor_user_id: "user-1",
                  created_at: "2026-09-25T00:00:00Z",
                },
              ],
            },
          ]}
        />
      ) as React.ReactElement
    );

    expect(html).toContain("Community management");
    expect(html).toContain("0.1.0");
    expect(html).toContain("Organization directory");
    expect(html).toContain("Ready");
    expect(html).toContain("Disabled");
    expect(html).toContain("was disabled");
    expect(html).toContain("Core — always enabled");
  });
});
