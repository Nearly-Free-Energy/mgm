/**
 * Community management's prepared actions against the local database, as
 * the GUI host prepares them (prepareAction) for a manager, with the real
 * runtime: each step's facts and name to type, the refusals it shares with
 * its route (billing the database keeps, a record with no name to type, the
 * tenant app off), and the `community.tenant-access` entity kind, which
 * resolves an access only beside the tenant whose list holds it, through
 * the manager's own client. Also the microgrid update's currency lock,
 * through the capability the route composes.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import type { User } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ceremony } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import { hostContext, surfaceRequest } from "@/lib/gui/host/server/access";
import { prepareAction } from "@/lib/gui/host/server/prepare";
import { composeCommunityManagement } from "@/lib/community-management";
import { COMMUNITY_MANAGEMENT_SURFACE } from "@/lib/community-management/surface";
import { TENANT_APP_PLUGIN_NAME, TENANT_APP_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import { resetMgmRuntimeForTests } from "@/lib/runtime/root";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";
import type { UserRoleRecord } from "@/lib/types/domain";
import { BROWSER } from "@/lib/runtime/caller";

const ORG = "e2781000-0000-4000-8000-000000000001";
const OTHER_ORG = "e2781000-0000-4000-8000-000000000002";
const COMMUNITY = "e2781000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e2781000-0000-4000-8001-000000000002";
const MG = "e2781000-0000-4000-8002-000000000001";
const OTHER_MG = "e2781000-0000-4000-8002-000000000002";
const SCHEDULE = "e2781000-0000-4000-8006-000000000001";
const PERIOD = "e2781000-0000-4000-8003-000000000001";
const BILL = "e2781000-0000-4000-8005-000000000001";
const PLAIN = "e2781000-0000-4000-8004-000000000001";
const BILLED = "e2781000-0000-4000-8004-000000000002";
const OTHERS = "e2781000-0000-4000-8004-000000000003";
/** A community, microgrid and tenant whose names are stored with outer spaces. */
const SPACED_COMMUNITY = "e2781000-0000-4000-8001-000000000003";
const SPACED_MG = "e2781000-0000-4000-8002-000000000003";
const SPACED_TENANT = "e2781000-0000-4000-8004-000000000004";
/** A community and microgrid holding a closed billing period, which the database keeps. */
const KEPT_COMMUNITY = "e2781000-0000-4000-8001-000000000004";
const KEPT_MG = "e2781000-0000-4000-8002-000000000004";
const KEPT_SCHEDULE = "e2781000-0000-4000-8006-000000000002";
const CLOSED_PERIOD = "e2781000-0000-4000-8003-000000000002";
/** A community, microgrid and tenant whose names are blank: nothing to type. */
const BLANK_COMMUNITY = "e2781000-0000-4000-8001-000000000005";
const BLANK_MG = "e2781000-0000-4000-8002-000000000005";
const BLANK_TENANT = "e2781000-0000-4000-8004-000000000005";
const ACCESS = "e2781000-0000-4000-800a-000000000001";
const OTHER_ACCESS = "e2781000-0000-4000-800a-000000000002";
const EMAILS = {
  manager: "cm-actions-manager@test.local",
  holder: "cm-actions-holder@test.local",
  otherHolder: "cm-actions-other-holder@test.local",
};

let manager: TestUser;
let roles: UserRoleRecord[];

function ctx() {
  const made = hostContext({ user: { id: manager.userId, email: EMAILS.manager } as User, roles }, new Headers({ "accept-language": "en-GB" }), {
    newClient: async () => manager.client,
    makeFmt: (locale) => createFmt({ locale }),
    caller: BROWSER,
  });
  if (!made.ok) throw new Error("[actions.db] context refused");
  return made.ctx;
}

async function prepare(action: string, params: Record<string, string>) {
  const out = await prepareAction(ctx(), { action, params });
  if (!out.ok) return { ok: false as const, status: out.status, code: out.code, message: out.message };
  return { ok: true as const, ceremony: out.value.ceremony as Ceremony, confirm: out.value.confirm, tone: out.value.tone };
}

async function setTenantApp(enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc
    .from("mgm_plugins")
    .upsert({ org_id: ORG, plugin_name: TENANT_APP_PLUGIN_NAME, version: TENANT_APP_PLUGIN_VERSION, enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[actions.db] mgm_plugins: ${error.message}`);
}

async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: Object.values(EMAILS) });
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  const svc = await serviceClient();
  const tenant = (id: string, microgrid: string, name: string, n: number) => ({
    id,
    microgrid_id: microgrid,
    display_name: name,
    unit_label: n === 1 ? "A1" : null,
    primary_phone: `+256700278${String(500 + n)}`,
  });
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "CM Actions Org" }, { id: OTHER_ORG, name: "CM Actions Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "Kisakye East" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "Elsewhere" },
        { id: SPACED_COMMUNITY, org_id: ORG, name: "  Spaced Community " },
        { id: KEPT_COMMUNITY, org_id: ORG, name: "Kept Community" },
        { id: BLANK_COMMUNITY, org_id: ORG, name: "   " },
      ],
    ],
    [
      "microgrids",
      [
        { id: MG, community_id: COMMUNITY, name: "Kisakye Site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: OTHER_MG, community_id: OTHER_COMMUNITY, name: "Elsewhere Site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: SPACED_MG, community_id: SPACED_COMMUNITY, name: " Spaced Site  ", currency: "UGX", timezone: "Africa/Kampala" },
        { id: KEPT_MG, community_id: KEPT_COMMUNITY, name: "Kept Site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: BLANK_MG, community_id: BLANK_COMMUNITY, name: " ", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    [
      "rate_schedules",
      [
        { id: SCHEDULE, microgrid_id: MG, tiers: [{ label: "Flat", min_kwh: 1, max_kwh: null, rate_per_kwh: 500 }], service_charge: 0, tax_rate: 0 },
        { id: KEPT_SCHEDULE, microgrid_id: KEPT_MG, tiers: [{ label: "Flat", min_kwh: 1, max_kwh: null, rate_per_kwh: 500 }], service_charge: 0, tax_rate: 0 },
      ],
    ],
    [
      "tenants",
      [
        tenant(PLAIN, MG, "Nakato", 1),
        tenant(BILLED, MG, "Okello", 2),
        tenant(OTHERS, OTHER_MG, "Elsewhere tenant", 3),
        tenant(SPACED_TENANT, SPACED_MG, "  Spaced Tenant ", 4),
        tenant(BLANK_TENANT, KEPT_MG, "  ", 5),
      ],
    ],
    [
      "billing_periods",
      [
        {
          id: PERIOD,
          microgrid_id: MG,
          start_date: "2026-10-01",
          end_date: "2026-10-31",
          timezone: "Africa/Kampala",
          status: "draft",
          rate_schedule_id: SCHEDULE,
        },
        {
          id: CLOSED_PERIOD,
          microgrid_id: KEPT_MG,
          start_date: "2026-09-01",
          end_date: "2026-09-30",
          timezone: "Africa/Kampala",
          status: "closed",
          closed_at: "2026-10-02T09:00:00Z",
          rate_schedule_id: KEPT_SCHEDULE,
        },
      ],
    ],
    [
      "billing_line_items",
      {
        id: BILL,
        billing_period_id: PERIOD,
        tenant_id: BILLED,
        start_kwh: 100,
        end_kwh: 110,
        usage_kwh: 10,
        tier_breakdown: [{ label: "Flat", kwh: 10, amount: 5000 }],
        total_amount: 5000,
        reading_source: "manual",
        manual_reason: "Dial photo",
      },
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[actions.db] ${table}: ${error.message}`);
  }
  for (const [email, id, scope] of [
    [EMAILS.holder, ACCESS, PLAIN],
    [EMAILS.otherHolder, OTHER_ACCESS, OTHERS],
  ] as const) {
    const holder = await createTestUser({ email, role: null });
    const { error } = await svc.from("user_roles").insert({ id, user_id: holder.userId, role: "tenant", scope_type: "tenant", scope_id: scope });
    if (error) throw new Error(`[actions.db] user_roles: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAILS.manager, role: "org_manager", scopeId: ORG });
  const held = await svc.from("user_roles").select("*").eq("user_id", manager.userId);
  if (held.error || !held.data?.length) throw new Error(`[actions.db] manager roles: ${held.error?.message ?? "none"}`);
  roles = held.data as UserRoleRecord[];
}, 120_000);

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanup();
  resetMgmRuntimeForTests();
}, 120_000);

describe.skipIf(shouldSkip())("community management's prepared actions (live database)", () => {
  it("asks for a community's name typed, with what goes with it, in the danger tone", async () => {
    const out = await prepare("community.delete-community", { id: COMMUNITY });
    expect(out).toMatchObject({ ok: true, confirm: "typed", tone: "danger" });
    if (!out.ok) return;
    expect(out.ceremony.typed).toBe("Kisakye East");
    expect(out.ceremony.statement).toBe("Delete the community Kisakye East and everything in it. This cannot be undone.");
    const facts = Object.fromEntries(out.ceremony.facts.map((f) => [f.label, f.value.text]));
    expect(facts).toMatchObject({ Community: "Kisakye East", Microgrids: "1", Tenants: "2", "Draft billing periods": "1", Bills: "1" });
    expect(out.ceremony.warnings).toEqual(["Its draft billing period is deleted too, with its readings and bills."]);
  });

  it("asks for a microgrid's name typed", async () => {
    const out = await prepare("community.delete-microgrid", { id: MG });
    expect(out).toMatchObject({ ok: true, confirm: "typed" });
    if (out.ok) expect(out.ceremony.typed).toBe("Kisakye Site");
  });

  it("refuses a tenant with billing history with the capability's copy, and asks for another's name", async () => {
    expect(await prepare("community.delete-tenant", { id: BILLED })).toMatchObject({
      ok: false,
      status: 409,
      message: "Cannot delete a tenant with billing history. Unlink its meter instead.",
    });
    const out = await prepare("community.delete-tenant", { id: PLAIN });
    expect(out).toMatchObject({ ok: true, confirm: "typed" });
    if (!out.ok) return;
    expect(out.ceremony.typed).toBe("Nakato");
    expect(Object.fromEntries(out.ceremony.facts.map((f) => [f.label, f.value.text]))).toEqual({
      Tenant: "Nakato",
      "People with app access": "1",
    });
    expect(out.ceremony.warnings).toEqual(["One person loses access to this unit's pages."]);
  });

  it("asks for a name stored with outer spaces without them, as the host compares what is typed trimmed", async () => {
    for (const [action, id, name] of [
      ["community.delete-community", SPACED_COMMUNITY, "Spaced Community"],
      ["community.delete-microgrid", SPACED_MG, "Spaced Site"],
      ["community.delete-tenant", SPACED_TENANT, "Spaced Tenant"],
    ] as const) {
      const out = await prepare(action, { id });
      expect(out, action).toMatchObject({ ok: true, confirm: "typed" });
      if (!out.ok) continue;
      expect(out.ceremony.typed, action).toBe(name);
      expect(out.ceremony.facts[0]?.value.text, action).toBe(name);
      expect(out.ceremony.statement, action).toContain(` ${name}`);
      expect(out.ceremony.statement, action).not.toMatch(/\s{2}/);
    }
  });

  it("refuses a community or microgrid that holds closed billing before the name is typed, with the delete preview's copy", async () => {
    expect(await prepare("community.delete-community", { id: KEPT_COMMUNITY })).toMatchObject({
      ok: false,
      status: 409,
      message:
        "This community has 1 closed billing period. Closed billing and billing with recorded payments are kept, so this community cannot be deleted.",
    });
    expect(await prepare("community.delete-microgrid", { id: KEPT_MG })).toMatchObject({
      ok: false,
      status: 409,
      message:
        "This microgrid has 1 closed billing period. Closed billing and billing with recorded payments are kept, so this microgrid cannot be deleted.",
    });
  });

  it("refuses a community, microgrid or tenant with no name to type, with the delete routes' copy", async () => {
    for (const [action, id] of [
      ["community.delete-community", BLANK_COMMUNITY],
      ["community.delete-microgrid", BLANK_MG],
      ["community.delete-tenant", BLANK_TENANT],
    ] as const) {
      expect(await prepare(action, { id }), action).toMatchObject({
        ok: false,
        status: 409,
        message: "Unnamed entity cannot be typed-to-confirm.",
      });
    }
  });

  it("keeps a microgrid's currency once a period is closed, through the capability the route composes", async () => {
    const composed = await composeCommunityManagement({ supabase: manager.client, organizationId: ORG });
    if (!composed.ok) throw new Error(`[actions.db] compose: ${composed.code}`);
    try {
      const cm = composed.data.communityManagement;
      expect(await cm.updateMicrogrid(KEPT_MG, { currency: "USD" })).toEqual({
        ok: false,
        status: 409,
        code: "microgrid_currency_locked",
        message:
          "The currency cannot change once a billing period is closed: this microgrid has 1 closed billing period, and its bills are shown in UGX.",
        field: "currency",
      });
      expect(await cm.updateMicrogrid(KEPT_MG, { currency: "UGX", address_city: "Jinja" })).toMatchObject({
        ok: true,
        data: { currency: "UGX", address_city: "Jinja" },
      });
      // SPACED_MG has no billing period: its currency may change.
      expect(await cm.updateMicrogrid(SPACED_MG, { currency: "USD" })).toMatchObject({ ok: true, data: { currency: "USD" } });
    } finally {
      await composed.data.dispose();
    }
    const svc = await serviceClient();
    const { data } = await svc.from("microgrids").select("id, currency").in("id", [KEPT_MG, SPACED_MG]).order("id");
    expect(data).toEqual([
      { id: SPACED_MG, currency: "USD" },
      { id: KEPT_MG, currency: "UGX" },
    ]);
  });

  it("refuses to give access while the tenant app is off, and names the unit once it is on", async () => {
    await setTenantApp(false);
    // available() answers first, with prepare's own copy, so the action
    // shows disabled with the reason before anyone opens it.
    expect(await prepare("community.grant-tenant-access", { id: PLAIN })).toMatchObject({
      ok: false,
      status: 409,
      code: "gui_action_unavailable",
      message: "The tenant app is not on for this organization yet. You can give access once it is on.",
    });
    await setTenantApp(true);
    const out = await prepare("community.grant-tenant-access", { id: PLAIN });
    expect(out).toMatchObject({ ok: true, confirm: "confirm", tone: "neutral" });
    if (out.ok) expect(out.ceremony.facts.map((f) => [f.label, f.value.text])).toEqual([["Unit", "Nakato, A1"]]);
  });

  it("says through available() which units wait on the tenant app, and finds no unit of another organization", async () => {
    const available = COMMUNITY_MANAGEMENT_SURFACE.actions?.find((a) => a.id === "community.grant-tenant-access")?.available;
    if (!available) throw new Error("[actions.db] grant-tenant-access declares no available()");
    const ask = async () => available(await surfaceRequest(ctx(), ORG, {}, new URLSearchParams()), [PLAIN, BILLED, OTHERS]);
    const OFF = "The tenant app is not on for this organization yet. You can give access once it is on.";
    const NOT_FOUND = "This tenant could not be found.";
    await setTenantApp(false);
    expect(await ask()).toEqual({ [PLAIN]: OFF, [BILLED]: OFF, [OTHERS]: NOT_FOUND });
    await setTenantApp(true);
    expect(await ask()).toEqual({ [PLAIN]: true, [BILLED]: true, [OTHERS]: NOT_FOUND });
  });

  it("names the address and the unit when removing an access the tenant's list holds", async () => {
    const out = await prepare("community.revoke-tenant-access", { id: PLAIN, accessId: ACCESS });
    expect(out).toMatchObject({ ok: true, confirm: "ceremony", tone: "danger" });
    if (!out.ok) return;
    expect(out.ceremony).toMatchObject({
      statement: `Remove ${EMAILS.holder}'s access to this unit's pages.`,
      acknowledgements: [],
    });
    expect(out.ceremony.typed).toBeUndefined();
    expect(out.ceremony.facts.map((f) => [f.label, f.value.text])).toEqual([
      ["Address", EMAILS.holder],
      ["Unit", "Nakato, A1"],
    ]);
  });

  it("finds no access beside a tenant whose list does not hold it, or in another organization", async () => {
    for (const params of [
      { id: BILLED, accessId: ACCESS },
      { id: PLAIN, accessId: OTHER_ACCESS },
      { id: OTHERS, accessId: OTHER_ACCESS },
      { id: PLAIN, accessId: "e2781000-0000-4000-800a-0000000000ff" },
    ]) {
      expect(await prepare("community.revoke-tenant-access", params), JSON.stringify(params)).toMatchObject({
        ok: false,
        status: 404,
        code: "gui_not_found",
      });
    }
  });
});
