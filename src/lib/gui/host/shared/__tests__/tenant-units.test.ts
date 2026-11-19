import { describe, expect, it } from "vitest";
import type { UserRoleRecord } from "@/lib/types/domain";
import { TENANT_APP_PLUGIN_NAME, getBundledPlugin } from "@/lib/plugins/bundled";
import { TENANT_APP_SURFACE } from "@/lib/tenant-app/surface";
import {
  TENANT_START_PAGE,
  TENANT_UNIT_PARAM,
  chooseTenantUnit,
  tenantUnitIds,
  unitHomeHref,
  unitsNamedBy,
  withUnit,
} from "../tenant-units";

const UNIT_A = "e7400000-0000-4000-8000-00000000000a";
const UNIT_B = "e7400000-0000-4000-8000-00000000000b";
const ORG = "e7400000-0000-4000-8000-0000000000f1";

type Row = Pick<UserRoleRecord, "role" | "scope_type" | "scope_id">;
const tenant = (id: string): Row => ({ role: "tenant", scope_type: "tenant", scope_id: id });
const manager: Row = { role: "org_manager", scope_type: "org", scope_id: ORG };
const admin: Row = { role: "super_admin", scope_type: "org", scope_id: null };

describe("tenantUnitIds", () => {
  it("lists the person's tenant rows' units, lowercased, sorted and once each", () => {
    expect(tenantUnitIds([tenant(UNIT_B.toUpperCase()), manager, tenant(UNIT_A), tenant(UNIT_B)])).toEqual([UNIT_A, UNIT_B]);
  });

  it("never counts a staff row, nor a tenant role on another scope", () => {
    expect(tenantUnitIds([manager, admin])).toEqual([]);
    expect(tenantUnitIds([{ role: "tenant", scope_type: "org", scope_id: UNIT_A }])).toEqual([]);
    expect(tenantUnitIds([{ role: "org_manager", scope_type: "tenant", scope_id: UNIT_A }])).toEqual([]);
    expect(tenantUnitIds([{ role: "tenant", scope_type: "tenant", scope_id: null }])).toEqual([]);
  });
});

describe("chooseTenantUnit", () => {
  it("picks a person's only unit when none is named", () => {
    expect(chooseTenantUnit([tenant(UNIT_A), manager], [])).toEqual({ ok: true, tenantId: UNIT_A });
  });

  it("picks the named unit among the person's own, in any case", () => {
    expect(chooseTenantUnit([tenant(UNIT_A), tenant(UNIT_B)], [UNIT_B.toUpperCase()])).toEqual({ ok: true, tenantId: UNIT_B });
  });

  it("asks a person with several units to choose when none is named", () => {
    expect(chooseTenantUnit([tenant(UNIT_A), tenant(UNIT_B)], [])).toEqual({ ok: false, reason: "choose" });
  });

  it("refuses a unit that is not the person's, a malformed one, or two at once", () => {
    expect(chooseTenantUnit([tenant(UNIT_A)], [UNIT_B])).toEqual({ ok: false, reason: "unknown" });
    expect(chooseTenantUnit([tenant(UNIT_A)], ["not-a-unit"])).toEqual({ ok: false, reason: "unknown" });
    expect(chooseTenantUnit([tenant(UNIT_A), tenant(UNIT_B)], [UNIT_A, UNIT_B])).toEqual({ ok: false, reason: "unknown" });
  });

  it("gives a person with no tenant row no unit, staff rows included", () => {
    expect(chooseTenantUnit([manager, admin], [])).toEqual({ ok: false, reason: "none" });
    expect(chooseTenantUnit([manager], [ORG])).toEqual({ ok: false, reason: "none" });
  });
});

describe("TENANT_START_PAGE", () => {
  it("is the tenant app's home: its page a view serves, which the tenant.home view and nav entry serve", () => {
    const page = getBundledPlugin(TENANT_APP_PLUGIN_NAME)?.pages.find((p) => p.path === TENANT_START_PAGE);
    expect(page).toMatchObject({ params: {}, servedBy: "view" });
    const view = TENANT_APP_SURFACE.views?.find((v) => v.path === TENANT_START_PAGE);
    expect(view).toMatchObject({ id: "tenant.home", scope: "tenant" });
    expect(TENANT_APP_SURFACE.nav?.find((n) => "view" in n && n.view === view?.id)).toMatchObject({ audience: "tenant" });
  });
});

describe("unit hrefs", () => {
  it("names the unit in the home only for a person with several", () => {
    expect(unitHomeHref(UNIT_A, false)).toBe("/my");
    expect(unitHomeHref(UNIT_A, true)).toBe(`/my?${TENANT_UNIT_PARAM}=${UNIT_A}`);
  });

  it("sets the unit on any page, keeping its other parameters and fragment and replacing a unit it named", () => {
    expect(withUnit("/my/usage?month=2026-11#top", UNIT_B)).toBe(`/my/usage?month=2026-11&unit=${UNIT_B}#top`);
    expect(withUnit(`/my?unit=${UNIT_A}&unit=x`, UNIT_B)).toBe(`/my?unit=${UNIT_B}`);
    expect(withUnit("/my", UNIT_A)).toBe(`/my?unit=${UNIT_A}`);
  });

  it("reads the units a path's query names, and none from a path with no query or no path", () => {
    expect(unitsNamedBy(`/my?month=2026-11&unit=${UNIT_A}#x`)).toEqual([UNIT_A]);
    expect(unitsNamedBy(`/my?unit=${UNIT_A}&unit=${UNIT_B}`)).toEqual([UNIT_A, UNIT_B]);
    expect(unitsNamedBy("/my#unit=x")).toEqual([]);
    expect(unitsNamedBy("/my")).toEqual([]);
    expect(unitsNamedBy(null)).toEqual([]);
  });
});
