// Tenant detail page — server component test (D3 / #54).
//
// Strategy:
//   - Mock @/lib/supabase/server so all three queries return fixture rows, and
//     the fn_tenant_access_list and mgm_plugin_enabled_for_org RPCs behind the
//     App access section.
//   - Call TenantDetailPage() directly (async server component) and serialize
//     the returned JSX to HTML.
//   - Cover scenarios: populated, empty devices, empty billing, query-error
//     surfaced (#300 throws, not 404), genuine-missing 404.
//   - Assert chip-highlight assertion for primary_consumption_meter row.
//
// Environment: node (same pattern as D2 page tests).

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// vi.hoisted() runs before vi.mock() hoisting — lets us capture the mock reference.
const { notFoundMock } = vi.hoisted(() => {
  const notFoundMock = vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  return { notFoundMock };
});

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  // Render as plain anchor for static markup serialization.
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => {
    return React.createElement("a", { href, className }, children);
  },
}));

// ── Auth access mock ──────────────────────────────────────────────────────────
// Stub so currentUserCanAccessMicrogrid doesn't hit Supabase auth.getUser.
vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: vi.fn().mockResolvedValue(true),
  currentUserIsSuperAdmin: vi.fn().mockResolvedValue(true),
  currentUserCanAccessCommunity: vi.fn().mockResolvedValue(true),
  currentUserCanAccessOrg: vi.fn().mockResolvedValue(true),
}));

// ── Supabase mock ────────────────────────────────────────────────────────────

const mockFrom = vi.fn();
// fn_tenant_access_list: one row per person who can sign in to the tenant's
// data (tenant role rows, RFC mgm#197). mgm_plugin_enabled_for_org: the
// tenant app's state for the microgrid's organization.
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom, rpc: mockRpc }),
}));

// The App access section renders for real; its props are recorded.
const { sectionProps } = vi.hoisted(() => ({ sectionProps: vi.fn() }));
vi.mock("./tenant-access-section", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tenant-access-section")>();
  return {
    ...actual,
    TenantAccessSection: (props: Parameters<typeof actual.TenantAccessSection>[0]) => {
      sectionProps(props);
      return actual.TenantAccessSection(props);
    },
  };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_BASE = {
  id: "hh-1",
  display_name: "Block A, Unit 1",
  primary_phone: "+256 772 414 001",
  primary_email: "aisha.m@example.org",
  address_line1: "Plot 14, Kisakye Ln",
  address_line2: "Block A",
  unit_label: "Unit 1",
};

const DEVICE_ROW = {
  id: "dev-1",
  name: "Chint Meter 01",
  device_type: "consumption_meter",
  edges: { id: "edge-1", name: "Metering Pi" },
};

const BILLING_PERIOD = {
  id: "bp-1",
  start_date: "2026-03-01",
  end_date: "2026-03-31",
  status: "closed",
};

// ── Query builder helpers ─────────────────────────────────────────────────────

/**
 * Builds a mock Supabase query chain for the tenants table.
 * Supports `.select().eq().eq().maybeSingle()` pattern (#300: switched from
 * .single() so 0 rows -> { data: null, error: null } instead of a PGRST116 error).
 */
function buildTenantQuery(data: unknown, error: unknown = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data, error }),
  };
  return chain;
}

/** fn_tenant_access_list's answer with `count` rows. */
function accessList(count: number) {
  const data = Array.from({ length: count }, (_, i) => ({
    access_id: `access-${i}`,
    email: `person-${i}@example.org`,
    created_at: "2026-11-18T00:00:00Z",
  }));
  return Promise.resolve({ data, error: null });
}

let accessAnswer: () => Promise<{ data: unknown; error: unknown }>;
let tenantAppAnswer: { data: boolean | null; error: { message: string } | null };

/** The RPCs the page makes, by name. */
function rpcByName(fn: string) {
  if (fn === "fn_tenant_access_list") return accessAnswer();
  if (fn === "mgm_plugin_enabled_for_org") return Promise.resolve(tenantAppAnswer);
  throw new Error(`Unexpected RPC: ${fn}`);
}

const MICROGRID_ROW = { timezone: "Africa/Kampala", communities: { org_id: "org-1" } };

/**
 * Builds a mock Supabase query chain for billing_line_items.
 * Supports `.select().eq().eq().order().limit().returns()` pattern.
 */
function buildLineItemsQuery(data: unknown) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    returns: () => Promise.resolve({ data, error: null }),
  };
  return chain;
}

/**
 * Builds a generic flexible query chain that handles the various query
 * patterns for edges, tenant_devices, devices (new in #139).
 * Returns { data: [], error: null } for .select().eq() chains and
 * { count: 0, error: null } for count queries.
 */
function buildFlexQuery(data: unknown[] = [], count = 0) {
  const chain: Record<string, unknown> = {};
  const resolve = () => Promise.resolve({ data, count, error: null });
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.in = () => chain;
  chain.is = () => chain;
  chain.not = () => resolve;
  chain.order = () => chain;
  chain.returns = () => Promise.resolve({ data, error: null });
  chain.maybeSingle = () => Promise.resolve({ data: data[0] ?? null, error: null });
  chain.single = () => Promise.resolve({ data: data[0] ?? null, error: null });
  // Make chain itself thenable so await on it works (direct .eq() returns promise)
  (chain as unknown as Promise<unknown>).then = (resolve2: unknown, reject: unknown) =>
    Promise.resolve({ data, count, error: null }).then(resolve2 as never, reject as never);
  return chain;
}

// ── Import page (after mocks) ─────────────────────────────────────────────────

import TenantDetailPage from "./page";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TenantDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MGM_APP_URL", "https://mgm.example.test");
    accessAnswer = () => accessList(0);
    tenantAppAnswer = { data: true, error: null };
    mockRpc.mockImplementation(rpcByName);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // (a) Populated: 1 primary_consumption_meter device + 1 closed billing period
  it("renders all sections for a populated tenant", async () => {
    accessAnswer = () => accessList(2);
    mockFrom.mockImplementation((table: string) => {
      if (table === "tenants") {
        return buildTenantQuery({
          ...TENANT_BASE,
          tenant_devices: [
            { role: "primary_consumption_meter", devices: DEVICE_ROW },
          ],
        });
      }
      if (table === "billing_line_items") {
        return buildLineItemsQuery([
          {
            usage_kwh: 45.3,
            total_amount: 12500,
            billing_periods: BILLING_PERIOD,
          },
        ]);
      }
      // edges, tenant_devices, devices queries for P7 hasMetersAvailable
      return buildFlexQuery([]);
    });

    const jsx = await TenantDetailPage({
      params: Promise.resolve({ id: "mg-1", tenantId: "hh-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Tenant basics
    expect(html).toContain("Block A, Unit 1");
    expect(html).toContain("+256 772 414 001");
    expect(html).toContain("aisha.m@example.org");
    expect(html).toContain("Plot 14, Kisakye Ln");
    expect(html).toContain("Block A");
    expect(html).toContain("Unit 1");

    // App access: listed from the tenant role rows, not tenant_users
    expect(html).toContain("App access");
    expect(html).toContain("person-0@example.org");
    expect(html).toContain("person-1@example.org");
    expect(mockRpc).toHaveBeenCalledWith("fn_tenant_access_list", { _tenant_id: "hh-1" });
    expect(mockFrom).not.toHaveBeenCalledWith("tenant_users");

    // Linked device name + edge link
    expect(html).toContain("Chint Meter 01");
    expect(html).toContain("Metering Pi");
    expect(html).toContain("/microgrids/mg-1/setup/edges/edge-1/");

    // Role chip for primary_consumption_meter — uses warn tone = bg-warning-muted text-warning-fg
    expect(html).toContain("Primary meter");
    // Primary row has bg-warning-muted highlight on the row
    expect(html).toContain("bg-warning-muted");

    // Billing history
    expect(html).toContain("2026-03-01");
    expect(html).toContain("2026-03-31");
    expect(html).toContain("45.3");
    expect(html).toContain("12,500");
  });

  // (b) Empty devices: 0 tenant_devices → EmptyState with warn tone (#139 P7)
  it("renders EmptyState 'Link this tenant to its meter' when no devices are linked", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "tenants") {
        return buildTenantQuery({
          ...TENANT_BASE,
          tenant_devices: [],
        });
      }
      if (table === "billing_line_items") {
        return buildLineItemsQuery([]);
      }
      // edges, tenant_devices, devices queries for P7 hasMetersAvailable
      return buildFlexQuery([]);
    });

    const jsx = await TenantDetailPage({
      params: Promise.resolve({ id: "mg-1", tenantId: "hh-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Link this tenant to its meter");
    expect(html).toContain("primary meter get billed");
    // Billing empty state should still appear (0 line items)
    expect(html).toContain("No billing history");
  });

  // (c) Empty billing: 0 closed billing periods
  it("renders empty billing state when no closed periods exist", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "tenants") {
        return buildTenantQuery({
          ...TENANT_BASE,
          tenant_devices: [
            { role: "primary_consumption_meter", devices: DEVICE_ROW },
          ],
        });
      }
      if (table === "billing_line_items") {
        return buildLineItemsQuery([]);
      }
      return buildFlexQuery([]);
    });

    const jsx = await TenantDetailPage({
      params: Promise.resolve({ id: "mg-1", tenantId: "hh-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No billing history");
    // Device section should still render
    expect(html).toContain("Chint Meter 01");
  });

  // (d) #300: a real query/embed error is SURFACED (thrown), not masked as 404.
  // Under the pre-#300 code this fixture (data:null + PGRST error) hit notFound();
  // now .maybeSingle() means a truthy error is a genuine failure → throw + log.
  it("throws (surfacing the error) when the tenant query returns a PostgREST error", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    mockFrom.mockImplementation((table: string) => {
      if (table === "tenants") {
        return buildTenantQuery(null, {
          message: "permission denied for table devices",
          code: "42501",
          details: "RLS on the embedded devices/edges relationship",
          hint: null,
        });
      }
      return buildFlexQuery([]);
    });

    await expect(
      TenantDetailPage({
        params: Promise.resolve({ id: "mg-1", tenantId: "hh-1" }),
      }),
    ).rejects.toThrow(/Failed to load tenant hh-1/);

    // The real error was surfaced, NOT swallowed into a 404.
    expect(notFoundMock).not.toHaveBeenCalled();
    // Structured diagnostic was logged.
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy.mock.calls[0][0]).toContain(
      "tenant_detail.query_error",
    );

    consoleErrorSpy.mockRestore();
  });

  // (e) #300: a genuinely-missing tenant (0 rows) still 404s. maybeSingle
  // returns { data: null, error: null } for no match → the !tenant branch.
  it("calls notFound() when the tenant genuinely does not exist (0 rows, no error)", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "tenants") {
        return buildTenantQuery(null, null);
      }
      return buildFlexQuery([]);
    });

    await expect(
      TenantDetailPage({
        params: Promise.resolve({ id: "mg-1", tenantId: "hh-unknown" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  // Chip highlight assertion: primary_consumption_meter row has warn-tone classes
  it("highlights primary_consumption_meter row with warning background", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "tenants") {
        return buildTenantQuery({
          ...TENANT_BASE,
          tenant_devices: [
            { role: "primary_consumption_meter", devices: DEVICE_ROW },
            {
              role: "secondary_meter",
              devices: {
                id: "dev-2",
                name: "Secondary",
                device_type: "consumption_meter",
                edges: { id: "edge-1", name: "Metering Pi" },
              },
            },
          ],
        });
      }
      if (table === "billing_line_items") {
        return buildLineItemsQuery([]);
      }
      return buildFlexQuery([]);
    });

    const jsx = await TenantDetailPage({
      params: Promise.resolve({ id: "mg-1", tenantId: "hh-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Primary row highlighted
    expect(html).toContain("bg-warning-muted");
    // Role chip label for primary
    expect(html).toContain("Primary meter");
    // Role chip label for secondary
    expect(html).toContain("Secondary meter");
  });

  // Meter assignment history (issue #4): effective-dated links render with
  // gaps called out, plus the opening-register CTA when the current meter
  // has no readings.
  it("renders assignment history with gaps and the opening-register CTA", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "tenants") {
        return buildTenantQuery({
          ...TENANT_BASE,
          tenant_devices: [
            { role: "primary_consumption_meter", devices: DEVICE_ROW },
          ],
        });
      }
      if (table === "billing_line_items") {
        return buildLineItemsQuery([]);
      }
      if (table === "tenant_devices") {
        return buildFlexQuery([
          {
            device_id: "dev-1",
            effective_from: "2026-01-01",
            effective_to: "2026-03-01",
            devices: { id: "dev-1", name: "Chint Meter 01" },
          },
          {
            device_id: "dev-2",
            effective_from: "2026-04-01",
            effective_to: null,
            devices: { id: "dev-2", name: "Chint Meter 02" },
          },
        ]);
      }
      // meter_readings count → 0 readings: CTA shows.
      return buildFlexQuery([], 0);
    });

    const jsx = await TenantDetailPage({
      params: Promise.resolve({ id: "mg-1", tenantId: "hh-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Meter assignment history");
    expect(html).toContain("Chint Meter 01");
    expect(html).toContain("2026-01-01");
    expect(html).toContain("Assignment gaps need attention");
    expect(html).toContain("2026-03-01");
    expect(html).toContain("Record opening register");
  });
  describe("App access", () => {
    function withMicrogrid() {
      mockFrom.mockImplementation((table: string) => {
        if (table === "tenants") {
          return buildTenantQuery({ ...TENANT_BASE, tenant_devices: [] });
        }
        if (table === "billing_line_items") return buildLineItemsQuery([]);
        if (table === "microgrids") return buildFlexQuery([MICROGRID_ROW]);
        return buildFlexQuery([]);
      });
    }

    async function render() {
      const jsx = await TenantDetailPage({
        params: Promise.resolve({ id: "mg-1", tenantId: "hh-1" }),
      });
      return renderToStaticMarkup(jsx as React.ReactElement);
    }

    it("passes the list, the tenant app's state, the zone and the sign-in page to the section", async () => {
      withMicrogrid();
      accessAnswer = () => accessList(1);
      await render();

      expect(sectionProps).toHaveBeenCalledTimes(1);
      expect(sectionProps.mock.calls[0][0]).toEqual({
        tenantId: "hh-1",
        entries: [
          { accessId: "access-0", email: "person-0@example.org", createdAt: "2026-11-18T00:00:00Z" },
        ],
        suggestedEmail: "aisha.m@example.org",
        canManage: true,
        tenantAppOn: true,
        timeZone: "Africa/Kampala",
        loginUrl: "https://mgm.example.test/login",
      });
      expect(mockRpc).toHaveBeenCalledWith("mgm_plugin_enabled_for_org", {
        _org_id: "org-1",
        _plugin_name: "tenant-app",
      });
    });

    it("passes null, never an empty list, when the list cannot be read", async () => {
      withMicrogrid();
      accessAnswer = () => Promise.resolve({ data: null, error: { code: "42501", message: "denied" } });
      const html = await render();

      expect(sectionProps.mock.calls[0][0].entries).toBeNull();
      expect(html).toContain("Could not load app access");
      expect(html).not.toContain("Nobody can sign in to this unit yet");
    });

    it("shows the empty state with Give access while nobody has access", async () => {
      withMicrogrid();
      const html = await render();

      expect(html).toContain("Give this tenant access to the app");
      expect(html).toContain("Nobody can sign in to this unit yet");
      expect(html).toContain(">Give access</button>");
    });

    it("hides Give access while the tenant app is off for the organization", async () => {
      withMicrogrid();
      tenantAppAnswer = { data: false, error: null };
      const html = await render();

      expect(sectionProps.mock.calls[0][0].tenantAppOn).toBe(false);
      expect(html).toContain("The tenant app is not on yet");
      expect(html).not.toContain(">Give access</button>");
    });

    it("passes an unknown tenant app state as null when it cannot be read", async () => {
      withMicrogrid();
      tenantAppAnswer = { data: null, error: { message: "unavailable" } };
      await render();

      expect(sectionProps.mock.calls[0][0].tenantAppOn).toBeNull();
    });

    it("renders without a sign-in address while MGM_APP_URL is unset", async () => {
      withMicrogrid();
      vi.stubEnv("MGM_APP_URL", "");
      await render();

      expect(sectionProps.mock.calls[0][0].loginUrl).toBeNull();
    });
  });
});
