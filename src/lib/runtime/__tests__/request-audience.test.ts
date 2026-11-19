/**
 * The audience of a request scope (MgmRequest.audience): who the request
 * acts for. composeTenantApp opens its scope for a tenant, whose
 * organization id is only their unit's and whose roles are only their
 * tenant rows; every capability plugin that trusts organizationId or roles
 * refuses to load into such a scope, and the tenant app loads into no other.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Plugin } from "cordis";
import { BillingPlugin } from "@/lib/billing/compose";
import { CommunityManagementPlugin } from "@/lib/community-management/compose";
import { BillingReviewPlugin } from "@/lib/cordis/billing-review";
import { MeteringPlugin } from "@/lib/metering/compose";
import { PaymentsPlugin } from "@/lib/payments/compose";
import { TenantAppPlugin } from "@/lib/tenant-app/compose";
import type { TenantUnit } from "@/lib/tenant-app/types";
import { getMgmRuntime, resetMgmRuntimeForTests } from "../root";
import { openOrganizationScope } from "../scope";
import { requireOrganizationAudience, type MgmRequest } from "../services";

const ORG = "550e8400-e29b-41d4-a716-44665544000a";
const UNIT = "550e8400-e29b-41d4-a716-4466554400a1";

const request = () => ({ organizationId: ORG, userId: "user-1", roles: [], supabase: {} as never });

const unit: TenantUnit = {
  tenantId: UNIT,
  displayName: "Unit A tenant",
  unitLabel: null,
  microgridId: "550e8400-e29b-41d4-a716-446655440099",
  microgridName: "Kasana East",
  timezone: "Africa/Kampala",
  currency: "UGX",
  organizationId: ORG,
};

/** Every capability plugin that takes organizationId and roles as organization access, with a config that would do. */
const ORGANIZATION_PLUGINS: [string, Plugin.Object<never>, unknown][] = [
  ["community-management", CommunityManagementPlugin as Plugin.Object<never>, undefined],
  ["metering", MeteringPlugin as Plugin.Object<never>, { repository: {} }],
  ["billing", BillingPlugin as Plugin.Object<never>, { repository: {} }],
  ["payments", PaymentsPlugin as Plugin.Object<never>, { repository: {} }],
  ["billing-review", BillingReviewPlugin as Plugin.Object<never>, {}],
];

afterEach(async () => {
  await resetMgmRuntimeForTests();
});

describe("openOrganizationScope's audience", () => {
  it("is the organization's unless the composer says otherwise", async () => {
    const scope = await openOrganizationScope(request());
    try {
      expect(scope.request.audience).toBe("organization");
      expect(scope.ctx.get("mgmRequest")).toBe(scope.request);
    } finally {
      await scope.dispose();
    }
  });

  it("is a tenant's when the composer opens it so", async () => {
    const scope = await openOrganizationScope(request(), { audience: "tenant" });
    try {
      expect(scope.ctx.get("mgmRequest")?.audience).toBe("tenant");
    } finally {
      await scope.dispose();
    }
  });

  it("never reopens a tenant's request as an organization's", async () => {
    const runtime = await getMgmRuntime();
    const before = runtime.root.registry.size;
    const tenantScope = await openOrganizationScope(request(), { audience: "tenant" });
    try {
      await expect(openOrganizationScope(tenantScope.request)).rejects.toThrow(
        "A request for the tenant audience cannot open as one for the organization audience"
      );
    } finally {
      await tenantScope.dispose();
    }
    expect(runtime.root.registry.size).toBe(before);
  });
});

describe("capability plugins in a tenant's scope", () => {
  it.each(ORGANIZATION_PLUGINS)("refuses to load %s into it", async (_name, plugin, config) => {
    const scope = await openOrganizationScope(request(), { audience: "tenant" });
    try {
      await expect(scope.load(plugin, config as never)).rejects.toThrow("loads only into an organization's request, not one for audience tenant");
    } finally {
      await scope.dispose();
    }
  });

  it.each(ORGANIZATION_PLUGINS)("still loads %s into an organization's scope", async (_name, plugin, config) => {
    const scope = await openOrganizationScope(request());
    try {
      await expect(scope.load(plugin, config as never)).resolves.toBeDefined();
    } finally {
      await scope.dispose();
    }
  });

  it("loads the tenant app into a tenant's scope only", async () => {
    const tenantScope = await openOrganizationScope(request(), { audience: "tenant" });
    try {
      await expect(tenantScope.load(TenantAppPlugin, { repository: {} as never, unit })).resolves.toBeDefined();
      expect(tenantScope.ctx.get("tenantApp")).toBeDefined();
    } finally {
      await tenantScope.dispose();
    }

    const organizationScope = await openOrganizationScope(request());
    try {
      await expect(organizationScope.load(TenantAppPlugin, { repository: {} as never, unit })).rejects.toThrow(
        "The tenant app acts only for a tenant's request"
      );
      expect(organizationScope.ctx.get("tenantApp")).toBeUndefined();
    } finally {
      await organizationScope.dispose();
    }
  });
});

describe("requireOrganizationAudience", () => {
  it("fails closed for a request built without openOrganizationScope", () => {
    const built = { ...request() } as unknown as MgmRequest;
    expect(() => requireOrganizationAudience(built, "Billing")).toThrow(
      "Billing loads only into an organization's request, not one for audience undefined"
    );
    expect(() => requireOrganizationAudience({ ...built, audience: "organization" }, "Billing")).not.toThrow();
  });
});
