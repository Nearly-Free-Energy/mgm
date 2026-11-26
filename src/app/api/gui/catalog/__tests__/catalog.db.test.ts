/**
 * GET /api/gui/catalog against the local database, with the real runtime:
 * the registered actions, the plugin gate reading mgm_plugins, the entity
 * resolver and each action's own available(), all through the caller's own
 * session. A manager gets every registered action; while billing is off its
 * actions are listed unavailable with the gate's code and copy, and while
 * Payments is off the actions its routes take anyway stay available; a
 * closed period makes close-period unavailable with the route's own copy.
 * Another organization's period is a 404, a person whose rows are all
 * tenant rows gets no actions, and no tenant's name reaches the answer.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionCatalog, CatalogEntry } from "@/lib/gui/contract";
import { getMgmRuntime } from "@/lib/runtime/root";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  LOCAL_SUPABASE_URL,
  mintServiceRoleJwt,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";

let caller: TestUser | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!caller) throw new Error("[catalog.db] no caller");
    return caller.client;
  },
}));

import { GET } from "../route";

const ORG = "e8900000-0000-4000-8000-000000000001";
const OTHER_ORG = "e8900000-0000-4000-8000-000000000002";
const COMMUNITY = "e8900000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e8900000-0000-4000-8001-000000000002";
const MICROGRID = "e8900000-0000-4000-8002-000000000001";
const OTHER_MICROGRID = "e8900000-0000-4000-8002-000000000002";
const SCHEDULE = "e8900000-0000-4000-8006-000000000001";
/** October: a draft with one bill. */
const DRAFT = "e8900000-0000-4000-8003-000000000001";
/** July: closed. */
const CLOSED = "e8900000-0000-4000-8003-000000000002";
/** Another organization's draft. */
const OTHERS = "e8900000-0000-4000-8003-000000000003";
const TENANT = "e8900000-0000-4000-8004-000000000001";
const TENANT_NAME = "Nakato Catalog-Canary";
const EMAIL = "gui-catalog-manager@test.local";
const TENANT_EMAIL = "gui-catalog-tenant@test.local";

/** Every action the bundled plugins contribute today. A new one fails this list until it is added here. */
const ACTION_IDS = [
  "billing.bill-from-readings",
  "billing.cancel-payment-link",
  "billing.close-period",
  "billing.create-period",
  "billing.delete-period",
  "billing.generate-from-meters",
  "billing.grid-tariff-add",
  "billing.mark-failed",
  "billing.mark-paid",
  "billing.mark-refunded",
  "billing.mark-unpaid",
  "billing.record-usage",
  "billing.regenerate-bill",
  "billing.savings-settings",
  "community.create-community",
  "community.create-microgrid",
  "community.create-tenant",
  "community.delete-community",
  "community.delete-microgrid",
  "community.delete-tenant",
  "community.grant-tenant-access",
  "community.revoke-tenant-access",
  "community.update-community",
  "community.update-microgrid",
  "community.update-tenant",
  "metering.check-connection",
  "metering.delete-edge",
  "metering.edit-device",
  "metering.edit-edge",
  "metering.record-opening-register",
  "metering.register-edges",
  "metering.save-connection",
  "metering.save-devices",
  "payments.accept-receipts",
  "payments.record-adjustment",
  "payments.refresh-attempt",
];
/** Payments actions whose routes take them while Payments is off (whilePluginOff: "enabled"). */
const KEPT_WHILE_PAYMENTS_OFF = ["payments.accept-receipts", "payments.record-adjustment", "payments.refresh-attempt"];

let manager: TestUser;
let tenantUser: TestUser;

const catalog = (query = "") => GET(new NextRequest(`http://localhost/api/gui/catalog${query}`, { headers: { "accept-language": "en-GB" } }));
async function answer(query = ""): Promise<{ body: ActionCatalog; text: string }> {
  const res = await catalog(query);
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return { body: JSON.parse(text) as ActionCatalog, text };
}
const byId = (body: ActionCatalog) => new Map<string, CatalogEntry>(body.actions.map((a) => [a.id, a]));

async function setPlugin(plugin: "billing" | "payments", enabled: boolean | null) {
  const svc = await serviceClient();
  const { error } =
    enabled === null
      ? await svc.from("mgm_plugins").delete().eq("org_id", ORG).eq("plugin_name", plugin)
      : await svc.from("mgm_plugins").upsert({ org_id: ORG, plugin_name: plugin, version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[catalog.db] mgm_plugins: ${error.message}`);
}

// cleanupTestData purges, as the database owner, the closed period the
// billing retention guards keep from an organization's delete.
async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, TENANT_EMAIL] });
}

const period = (id: string, microgridId: string, month: string, last: string, o: Record<string, unknown> = {}) => ({
  id,
  microgrid_id: microgridId,
  start_date: `2026-${month}-01`,
  end_date: `2026-${month}-${last}`,
  timezone: "Africa/Kampala",
  status: "draft",
  closed_at: null,
  rate_schedule_id: microgridId === MICROGRID ? SCHEDULE : null,
  ...o,
});
const bill = (n: number, periodId: string) => ({
  id: `e8900000-0000-4000-8005-00000000000${n}`,
  billing_period_id: periodId,
  tenant_id: TENANT,
  start_kwh: 100,
  end_kwh: 110,
  usage_kwh: 10,
  tier_breakdown: [{ label: "Lifeline", kwh: 10, amount: 2500 }],
  total_amount: 2500,
  reading_source: "edge",
  payment_status: "unpaid",
  paid_at: null,
  invoice_number: null,
});

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // An available() that composes a capability builds its service-role
  // client from these (src/lib/supabase/service.ts); none reaches outside
  // the local Supabase. If that file reads other names, revisit.
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  await cleanup();
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "GUI Catalog Org" }, { id: OTHER_ORG, name: "GUI Catalog Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "GUI Catalog Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI Catalog Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "Catalog site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: OTHER_MICROGRID, community_id: OTHER_COMMUNITY, name: "Other catalog site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    [
      "rate_schedules",
      { id: SCHEDULE, microgrid_id: MICROGRID, tiers: [{ label: "Lifeline", min_kwh: 1, max_kwh: null, rate_per_kwh: 250 }], service_charge: 0, tax_rate: 0 },
    ],
    ["tenants", { id: TENANT, microgrid_id: MICROGRID, display_name: TENANT_NAME, primary_phone: "+256700000911" }],
    [
      "billing_periods",
      [
        period(DRAFT, MICROGRID, "10", "31"),
        period(CLOSED, MICROGRID, "07", "31", { status: "closed", closed_at: "2026-08-03T09:00:00+00:00" }),
        period(OTHERS, OTHER_MICROGRID, "10", "31"),
      ],
    ],
    ["billing_line_items", [bill(1, DRAFT), bill(2, CLOSED)]],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[catalog.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: TENANT });
}, 120_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
  vi.unstubAllEnvs();
}, 120_000);

describe.skipIf(shouldSkip())("GET /api/gui/catalog against the database", () => {
  it("gives a manager every registered action, each with a described input and nothing undecided read as passed", async () => {
    caller = manager;
    await setPlugin("billing", null);
    await setPlugin("payments", null);
    const { body } = await answer(`?org=${ORG}`);
    expect(body).toMatchObject({ type: "catalog", org: ORG, entities: [] });
    expect(body.actions.map((a) => a.id).sort()).toEqual(ACTION_IDS);
    for (const a of body.actions) {
      expect(a.input, a.id).toMatchObject({ type: "object" });
      expect(a.availability, a.id).toEqual({ available: true, reasons: [], unchecked: ["configured", "authorized", "state"] });
    }
  });

  it("describes the OpenEMS connection's credentials as write-only, a schema with no value", async () => {
    caller = manager;
    const save = byId((await answer(`?org=${ORG}`)).body).get("metering.save-connection");
    const properties = (save?.input as { properties: Record<string, Record<string, unknown>> }).properties;
    for (const key of ["secretAccessKey", "basicAuthPassword", "bearerToken", "keycloakClientSecret"]) {
      expect(properties[key], key).toEqual({ type: "string", title: expect.any(String), writeOnly: true });
    }
    // The host sends the ceremony's confirmation itself, so no form asks for it.
    expect(Object.keys(properties)).not.toContain("confirmation");
    expect(save).toMatchObject({
      method: "PUT",
      confirm: "ceremony",
      humanOnly: true,
      repeat: "unsafe",
      bind: { path: { id: "microgrid" }, body: {} },
      prepareAgainOn: ["metering_connection_name_required"],
    });
    // The page's own field is described, and marked deprecated.
    expect(properties.confirmed_name).toMatchObject({ type: "string", deprecated: true });
  });

  it("lists billing's actions unavailable with the gate's code and copy while billing is off", async () => {
    caller = manager;
    await setPlugin("billing", false);
    try {
      const copy = (await getMgmRuntime()).gate.disabledMessage("billing");
      const actions = byId((await answer()).body);
      expect(actions.size).toBe(ACTION_IDS.length);
      for (const [id, a] of actions) {
        if (a.plugin !== "billing") continue;
        expect(a.availability.available, id).toBe(false);
        expect(a.availability.reasons, id).toEqual([{ check: "enabled", code: "billing_disabled", message: copy }]);
      }
    } finally {
      await setPlugin("billing", null);
    }
  });

  it("keeps the actions Payments' routes take while it is off available", async () => {
    caller = manager;
    await setPlugin("payments", false);
    try {
      // The control: the gate, asked as the host asks it, reads Payments as
      // off, so an action listed with no reason was let through by its
      // whilePluginOff, not by a gate that never saw the row.
      const { gate } = await getMgmRuntime();
      const decision = await gate.check(manager.client, {
        plugin: "payments",
        target: { kind: "organization", id: ORG },
        method: "GET",
        access: "write",
      });
      expect(decision).toEqual({ ok: false, status: 409, code: "payments_disabled", message: gate.disabledMessage("payments") });

      const actions = byId((await answer()).body);
      expect([...actions.values()].filter((a) => a.plugin === "payments").map((a) => a.id).sort()).toEqual(KEPT_WHILE_PAYMENTS_OFF);
      for (const id of KEPT_WHILE_PAYMENTS_OFF) {
        expect(actions.get(id)!.availability, id).toEqual({ available: true, reasons: [], unchecked: ["configured", "authorized", "state"] });
      }
    } finally {
      await setPlugin("payments", null);
    }
  });

  it("asks each action on a closed period its own available(), with the route's copy", async () => {
    caller = manager;
    const { body } = await answer(`?entity=billingPeriod:${CLOSED}`);
    expect(body.entities).toEqual([{ kind: "billingPeriod", id: CLOSED }]);
    const actions = byId(body);
    expect([...actions.values()].every((a) => a.target === "billingPeriod")).toBe(true);
    expect(actions.get("billing.close-period")).toMatchObject({
      params: { periodId: CLOSED },
      availability: {
        available: false,
        reasons: [{ check: "state", code: "gui_action_unavailable", message: "Billing period is already closed." }],
        unchecked: ["configured", "authorized"],
      },
    });
    // Its tenant not given, bill-from-readings is not filled and its state not asked.
    expect(actions.get("billing.bill-from-readings")).not.toHaveProperty("params");
    expect(actions.get("billing.bill-from-readings")!.availability.unchecked).toContain("state");

    const draft = byId((await answer(`?entity=billingPeriod:${DRAFT}`)).body);
    expect(draft.get("billing.generate-from-meters")!.availability).toEqual({ available: true, reasons: [], unchecked: ["configured", "authorized"] });
  });

  it("answers 404 for another organization's period, and for an organization the manager cannot see", async () => {
    caller = manager;
    for (const query of [`?entity=billingPeriod:${OTHERS}`, `?org=${OTHER_ORG}`]) {
      const res = await catalog(query);
      expect(res.status, query).toBe(404);
      expect(await res.json()).toMatchObject({ code: "gui_not_found" });
    }
  });

  it("never names a tenant, even asked about one", async () => {
    caller = manager;
    const { body, text } = await answer(`?entity=tenant:${TENANT}&entity=billingPeriod:${DRAFT}`);
    expect(body.entities).toEqual([
      { kind: "tenant", id: TENANT },
      { kind: "billingPeriod", id: DRAFT },
    ]);
    expect(byId(body).get("billing.bill-from-readings")).toMatchObject({ params: { periodId: DRAFT, tenantId: TENANT } });
    expect(text).not.toContain(TENANT_NAME);
  });

  it("gives a person whose rows are all tenant rows no actions, and a 404 for their own unit", async () => {
    caller = tenantUser;
    const { body } = await answer();
    expect(body).toMatchObject({ type: "catalog", org: null, entities: [], actions: [] });
    expect((await catalog(`?entity=tenant:${TENANT}`)).status).toBe(404);
  });
});
