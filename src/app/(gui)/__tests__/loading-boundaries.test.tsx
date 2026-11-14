// Dashboard loading boundaries test (node environment).
//
// Each loading.tsx below is what a navigation shows at once instead of
// freezing on the old page until the server responds. Next.js shows a
// folder's loading.tsx when the route segment directly below that folder
// changes, so each file covers one kind of move (top-level section, list →
// detail, tab switch). This checks every boundary still exists and announces
// itself once.
//
// Strategy: renderToStaticMarkup (pure server components, no data deps).

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

import DashboardLoading from "../loading";
import OrganizationsLoading from "../organizations/loading";
import OrganizationLoading from "../organizations/[id]/loading";
import CommunitiesLoading from "../communities/loading";
import CommunityLoading from "../communities/[id]/loading";
import MicrogridsLoading from "../microgrids/loading";
import SetupLoading from "../microgrids/[id]/setup/loading";
import HouseholdsLoading from "../microgrids/[id]/setup/households/loading";
import EdgesLoading from "../microgrids/[id]/setup/edges/loading";
import SettingsLoading from "../settings/loading";

const BOUNDARIES: [string, React.ComponentType, string][] = [
  ["(gui)", DashboardLoading, "page"],
  ["organizations", OrganizationsLoading, "organization"],
  ["organizations/[id]", OrganizationLoading, "organization"],
  ["communities", CommunitiesLoading, "community"],
  ["communities/[id]", CommunityLoading, "community"],
  ["microgrids", MicrogridsLoading, "microgrid"],
  ["microgrids/[id]/setup", SetupLoading, "setup"],
  ["microgrids/[id]/setup/households", HouseholdsLoading, "household"],
  ["microgrids/[id]/setup/edges", EdgesLoading, "edge"],
  ["settings", SettingsLoading, "settings"],
];

describe.each(BOUNDARIES)("%s/loading.tsx", (_folder, Loading, label) => {
  it("announces itself once via role=status", () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain(`aria-label="Loading ${label}"`);
    expect(html).toContain(`Loading ${label}…`);
  });

  it("marks itself busy and hides blocks from assistive tech", () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("settings/loading.tsx", () => {
  it("draws no breadcrumb row, since the settings pages have none", () => {
    const withBreadcrumb = renderToStaticMarkup(<CommunitiesLoading />);
    const settings = renderToStaticMarkup(<SettingsLoading />);
    expect(withBreadcrumb).toContain("h-9 w-36");
    expect(settings).not.toContain("h-9 w-36");
  });
});
