/**
 * The lower limit on views whose `cost` is "vendor" for clients that are not
 * a browser (checkClientVendorRead in @/lib/runtime/client-limits, asked by
 * dispatchView): a client's loads of a vendor view are counted per person
 * and client, and past the limit the view is refused with 429
 * `gui_rate_limited` and the seconds to wait, before its loader runs. A
 * browser session is never counted, a db view is never counted, and a
 * vendor view the gate refuses costs nothing. The gate, the snapshot and
 * the clients are fakes, as in view.test.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MgmPluginName } from "@/lib/plugins/bundled";
import type { Caller } from "@/lib/runtime/caller";
import { CLIENT_VENDOR_READS_PER_WINDOW, _resetClientLimitersForTests } from "@/lib/runtime/client-limits";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { ViewDef } from "../../../surface";
import type { RegisteredView, SurfaceSnapshot } from "../surface-registry";

const checkGate = vi.fn();
vi.mock("@/lib/runtime/gate", async (importOriginal) => ({
  codePrefix: (await importOriginal<typeof import("@/lib/runtime/gate")>()).codePrefix,
  checkGate: (...args: unknown[]) => checkGate(...args),
  resolveTargetOrganization: vi.fn(),
}));
let snapshot: SurfaceSnapshot;
vi.mock("../snapshot", () => ({ surfaceSnapshot: async () => snapshot }));

import { hostOutcome } from "../http";
import { dispatchView } from "../view";
import { ORG_A, contextFor, managerOf, tableClient, tenantOf } from "./host-fakes";

const OPERATOR: Caller = { kind: "operator", clientId: "e7100000-0000-4000-8fff-0000000000c1" };
const OTHER_CLIENT: Caller = { kind: "operator", clientId: "e7100000-0000-4000-8fff-0000000000c2" };
const UNIT = "e7400000-0000-4000-8000-00000000000a";

const metrics = { title: "Today", actions: [], body: { tiles: [{ key: "soc", label: "Battery", value: { t: "percent", v: 50, text: "50%" } }] } };

function view(plugin: MgmPluginName, def: Partial<ViewDef> & Pick<ViewDef, "id" | "path">): RegisteredView {
  return {
    plugin,
    def: {
      kind: "metrics",
      params: {},
      cost: "vendor",
      declares: { keys: ["soc"] },
      examples: [{ title: `${def.id} example` }],
      load: vi.fn(async () => ({ ok: true, model: metrics })),
      ...def,
    } as unknown as ViewDef,
  };
}

const vendorView = view("metering", { id: "metering.today", path: "/billing" });
const dbView = view("billing", { id: "billing.home", path: "/organizations", cost: "db" });
const tenantVendor = view("tenant-app", {
  id: "tenant.usage",
  path: "/my",
  scope: "tenant",
  kind: "record",
} as unknown as Partial<ViewDef> & Pick<ViewDef, "id" | "path">);

function ctx(caller?: Caller, roles: UserRoleRecord[] = [managerOf(ORG_A)]) {
  const newClient = vi.fn(async () => tableClient({ organizations: { data: [{ id: ORG_A, name: "Alpha" }] } }).client as SupabaseClient);
  return contextFor(roles, newClient, caller);
}
const loads = (v: RegisteredView) => vi.mocked(v.def.load).mock.calls.length;

beforeEach(() => {
  _resetClientLimitersForTests();
  checkGate.mockReset().mockResolvedValue({ ok: true, organizationId: ORG_A });
  snapshot = {
    views: [vendorView, dbView, tenantVendor],
    actions: new Map(),
    nav: [],
    signals: [],
    status: [],
    search: [],
    entities: new Map(),
    guis: [],
  };
  for (const v of snapshot.views) vi.mocked(v.def.load).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Loads `href` `times` times for `caller`, expecting each to be served. */
async function fill(href: string, caller: Caller | undefined, times = CLIENT_VENDOR_READS_PER_WINDOW, roles?: UserRoleRecord[]) {
  for (let i = 0; i < times; i++) expect(await dispatchView(ctx(caller, roles), href)).toMatchObject({ ok: true });
}

describe("a client's loads of a vendor view", () => {
  it("are refused past the limit with 429 gui_rate_limited and the seconds to wait, before the loader runs", async () => {
    await fill(`/billing?org=${ORG_A}`, OPERATOR);
    const out = await dispatchView(ctx(OPERATOR), `/billing?org=${ORG_A}`);
    expect(out).toMatchObject({ ok: false, status: 429, code: "gui_rate_limited" });
    expect(!out.ok && out.retryAfter).toBeGreaterThanOrEqual(1);
    expect(loads(vendorView)).toBe(CLIENT_VENDOR_READS_PER_WINDOW);
  });

  it("are answered over HTTP with Retry-After and the host's refusal body", async () => {
    await fill(`/billing?org=${ORG_A}`, OPERATOR);
    const res = hostOutcome(await dispatchView(ctx(OPERATOR), `/billing?org=${ORG_A}`));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await res.json()).toMatchObject({ ok: false, status: 429, code: "gui_rate_limited", error: expect.any(String) });
  });

  it("are counted apart for each client", async () => {
    await fill(`/billing?org=${ORG_A}`, OPERATOR);
    expect(await dispatchView(ctx(OTHER_CLIENT), `/billing?org=${ORG_A}`)).toMatchObject({ ok: true });
  });

  it("leave the same client's db views alone", async () => {
    await fill(`/billing?org=${ORG_A}`, OPERATOR);
    expect(await dispatchView(ctx(OPERATOR), `/organizations?org=${ORG_A}`)).toMatchObject({ ok: true });
  });

  it("are not counted while the gate refuses the view", async () => {
    checkGate.mockResolvedValue({ ok: false, status: 409, code: "metering_disabled", message: "Metering is disabled." });
    for (let i = 0; i < CLIENT_VENDOR_READS_PER_WINDOW; i++) await dispatchView(ctx(OPERATOR), `/billing?org=${ORG_A}`);
    checkGate.mockResolvedValue({ ok: true, organizationId: ORG_A });
    expect(await dispatchView(ctx(OPERATOR), `/billing?org=${ORG_A}`)).toMatchObject({ ok: true });
  });

  it("of a tenant view are limited too", async () => {
    const tenant = [tenantOf(UNIT)];
    vi.mocked(tenantVendor.def.load).mockResolvedValue({
      ok: true,
      model: {
        title: "Usage",
        entity: { kind: "tenant", id: UNIT, label: "Unit 4" },
        actions: [],
        body: { sections: [{ fields: [{ key: "soc", label: "Use", value: { t: "text", text: "4 kWh" } }] }] },
      },
    } as never);
    await fill("/my", OPERATOR, CLIENT_VENDOR_READS_PER_WINDOW, tenant);
    expect(await dispatchView(ctx(OPERATOR, tenant), "/my")).toMatchObject({ ok: false, status: 429, code: "gui_rate_limited" });
  });
});

describe("a browser session's loads of a vendor view", () => {
  it("are never counted", async () => {
    await fill(`/billing?org=${ORG_A}`, undefined, CLIENT_VENDOR_READS_PER_WINDOW + 5);
    expect(await dispatchView(ctx(OPERATOR), `/billing?org=${ORG_A}`)).toMatchObject({ ok: true });
  });
});
