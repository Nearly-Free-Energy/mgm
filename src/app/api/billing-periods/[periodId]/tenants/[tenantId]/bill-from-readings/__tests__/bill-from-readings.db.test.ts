/**
 * POST /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings
 * against a live database, run through the GUI host the way a GUI runs it:
 * POST /api/gui/prepare for `billing.bill-from-readings`, whose
 * confirmation names the tenant, the period and the meter, then the form's
 * readings as the host's invoke sends them to the route.
 *
 * A tenant with no meter and no bill is billed from the readings entered:
 * one manual bill, readings to 3 places, usage the end less the start,
 * priced with the period's tariff, which the run pins, and one audit row.
 * A second submission is refused and writes nothing. A tenant with a bill,
 * a tenant of another microgrid of the organization, a closed period,
 * billing turned off, another organization's manager, a tenant-only
 * account, no session and readings that go backwards are all refused, with
 * nothing written. A bill that appears after the route's own check is
 * found by the engine's, and left as it is.
 *
 * Self-fixturing. Requires a running local Supabase (same harness as
 * rls.test.ts).
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  LOCAL_SUPABASE_URL,
  serviceClient,
  shouldSkip,
  testAnonKey,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";

let caller: TestUser | "anon" | null = null;
/** Runs once, when the engine pins the period's tariff: after the route's own checks, before the engine reads the period's bills. */
let beforePin: (() => Promise<void>) | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (caller === "anon") return createClient(LOCAL_SUPABASE_URL, testAnonKey() ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
    if (!caller) throw new Error("[bill-from-readings.db] no caller");
    const client = caller.client;
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "rpc") {
          return async (name: string, args?: Record<string, unknown>) => {
            if (name === "fn_pin_billing_period_rate_schedule" && beforePin) {
              const hook = beforePin;
              beforePin = null;
              await hook();
            }
            return target.rpc(name, args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
}));

import { calculateTieredCost } from "@/lib/billing/calculations";
import { invoke } from "@/lib/gui/host/client/invoke";
import type { PreparedAction } from "@/lib/gui/host/server/prepare";
import { BILL_FROM_READINGS_COPY } from "@/lib/billing/schemas";
import { POST as prepareRoute } from "@/app/api/gui/prepare/route";
import { POST } from "../route";

const ORG = "e7c10000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7c10000-0000-4000-8000-000000000002";
const COMMUNITY = "e7c10000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e7c10000-0000-4000-8001-000000000002";
const MICROGRID = "e7c10000-0000-4000-8002-000000000001";
/** Another microgrid of the same organization. */
const SECOND = "e7c10000-0000-4000-8002-000000000002";
const EDGE = "e7c10000-0000-4000-8009-000000000001";
const SCHEDULE = "e7c10000-0000-4000-8006-000000000001";
/** October: a draft with no tariff pinned yet, and unit 3's bill. */
const DRAFT = "e7c10000-0000-4000-8003-000000000001";
/** September: closed. */
const CLOSED = "e7c10000-0000-4000-8003-000000000002";
/** November: for the bill that appears after the route's check. */
const RACE = "e7c10000-0000-4000-8003-000000000003";
const tenant = (n: number) => `e7c10000-0000-4000-8004-${String(n).padStart(12, "0")}`;
const device = (n: number) => `e7c10000-0000-4000-8007-${String(n).padStart(12, "0")}`;
const EMAIL = "bill-readings-db-manager@test.local";
const OTHER_EMAIL = "bill-readings-db-other@test.local";
const TENANT_EMAIL = "bill-readings-db-tenant@test.local";

const TIERS = [
  { label: "Lifeline", min_kwh: 1, max_kwh: 15, rate_per_kwh: 250 },
  { label: "Standard", min_kwh: 16, max_kwh: null, rate_per_kwh: 750 },
];
const READINGS = { start_kwh: 100.1234, end_kwh: 150.5, reason: "Dial read on site" };
const EXPECTED = calculateTieredCost(READINGS.end_kwh - READINGS.start_kwh, TIERS, 0, 0);

let manager: TestUser;
let other: TestUser;
let tenantUser: TestUser;

/** 1 no meter; 2 a meter assigned only after the period began; 3 metered, with an October bill; 4 on the second microgrid. */
const billRow = (periodId: string, n: number) => ({
  billing_period_id: periodId,
  tenant_id: tenant(n),
  device_id: null,
  start_kwh: null,
  end_kwh: null,
  usage_kwh: 30,
  tier_breakdown: [
    { label: "Lifeline", kwh: 15, amount: 3750 },
    { label: "Standard", kwh: 15, amount: 11250 },
  ],
  total_amount: 15000,
  reading_source: "edge",
  payment_status: "unpaid",
});

const submit = (periodId: string, tenantId: string, body: unknown) =>
  POST(
    new NextRequest(`http://localhost/api/billing-periods/${periodId}/tenants/${tenantId}/bill-from-readings`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en-GB" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ periodId, tenantId }) },
  );
const prepare = (periodId: string, tenantId: string) =>
  prepareRoute(
    new NextRequest("http://localhost/api/gui/prepare", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en-GB" },
      body: JSON.stringify({ action: "billing.bill-from-readings", params: { periodId, tenantId } }),
    }),
  );
/** What a GUI's fetch does with the host's write: the route, as Next.js would route it. */
const routeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  const match = /^\/api\/billing-periods\/([^/]+)\/tenants\/([^/]+)\/bill-from-readings$/.exec(url);
  if (!match || init.method !== "POST") throw new Error(`[bill-from-readings.db] unexpected write ${init.method} ${url}`);
  return submit(match[1], match[2], JSON.parse(init.body as string));
};

async function setBilling(enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc
    .from("mgm_plugins")
    .upsert({ org_id: ORG, plugin_name: "billing", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[bill-from-readings.db] mgm_plugins: ${error.message}`);
}

type Bill = {
  id: string;
  tenant_id: string;
  device_id: string | null;
  start_kwh: number | null;
  end_kwh: number | null;
  usage_kwh: number | null;
  total_amount: number;
  tier_breakdown: unknown;
  reading_source: string;
  payment_status: string;
  entered_by_user_id: string | null;
  manual_reason: string | null;
};

async function bills(periodId = DRAFT): Promise<Map<string, Bill>> {
  const svc = await serviceClient();
  const { data, error } = await svc
    .from("billing_line_items")
    .select("id, tenant_id, device_id, start_kwh, end_kwh, usage_kwh, total_amount, tier_breakdown, reading_source, payment_status, entered_by_user_id, manual_reason")
    .eq("billing_period_id", periodId);
  if (error) throw new Error(`[bill-from-readings.db] bills: ${error.message}`);
  const num = (v: unknown) => (v === null ? null : Number(v));
  return new Map(
    ((data ?? []) as Bill[]).map((b) => [
      b.tenant_id,
      { ...b, start_kwh: num(b.start_kwh), end_kwh: num(b.end_kwh), usage_kwh: num(b.usage_kwh), total_amount: Number(b.total_amount) },
    ]),
  );
}

async function auditRows(periodId = DRAFT): Promise<{ billing_line_item_id: string | null; event_type: string }[]> {
  const svc = await serviceClient();
  const { data, error } = await svc.from("billing_audit_log").select("billing_line_item_id, event_type").eq("billing_period_id", periodId);
  if (error) throw new Error(`[bill-from-readings.db] billing_audit_log: ${error.message}`);
  return (data ?? []) as { billing_line_item_id: string | null; event_type: string }[];
}

async function pinned(periodId = DRAFT): Promise<string | null> {
  const svc = await serviceClient();
  const { data, error } = await svc.from("billing_periods").select("rate_schedule_id").eq("id", periodId).single();
  if (error) throw new Error(`[bill-from-readings.db] billing_periods: ${error.message}`);
  return (data as { rate_schedule_id: string | null }).rate_schedule_id;
}

async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, OTHER_EMAIL, TENANT_EMAIL] });
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  const svc = await serviceClient();
  const closedAt = new Date().toISOString();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "Bill Readings DB Org" }, { id: OTHER_ORG, name: "Bill Readings DB Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "Bill Readings DB Community", invoice_prefix: "BRD" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "Bill Readings DB Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "Readings site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: SECOND, community_id: COMMUNITY, name: "Second readings site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    ["rate_schedules", { id: SCHEDULE, microgrid_id: MICROGRID, tiers: TIERS, service_charge: 0, tax_rate: 0 }],
    ["edges", { id: EDGE, microgrid_id: MICROGRID, name: "Readings edge", openems_edge_id: "bill-readings-edge" }],
    [
      "devices",
      [2, 3].map((n) => ({ id: device(n), edge_id: EDGE, name: `Meter ${n}`, device_type: "consumption_meter", openems_component_id: `meter${n}` })),
    ],
    [
      "tenants",
      [
        ...[1, 2, 3].map((n) => ({ id: tenant(n), microgrid_id: MICROGRID, display_name: `Unit ${n}`, primary_phone: `+2567000008${String(n).padStart(2, "0")}` })),
        { id: tenant(4), microgrid_id: SECOND, display_name: "Unit 4", primary_phone: "+256700000804" },
      ],
    ],
    [
      "tenant_devices",
      [
        { tenant_id: tenant(2), device_id: device(2), role: "primary_consumption_meter", effective_from: "2026-10-15" },
        { tenant_id: tenant(3), device_id: device(3), role: "primary_consumption_meter", effective_from: "2026-01-01" },
      ],
    ],
    [
      "billing_periods",
      [
        { id: CLOSED, microgrid_id: MICROGRID, start_date: "2026-09-01", end_date: "2026-09-30", timezone: "Africa/Kampala", status: "closed", closed_at: closedAt, rate_schedule_id: SCHEDULE },
        { id: DRAFT, microgrid_id: MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala", status: "draft", closed_at: null, rate_schedule_id: SCHEDULE },
        { id: RACE, microgrid_id: MICROGRID, start_date: "2026-11-01", end_date: "2026-11-30", timezone: "Africa/Kampala", status: "draft", closed_at: null, rate_schedule_id: SCHEDULE },
      ],
    ],
    ["billing_line_items", billRow(DRAFT, 3)],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[bill-from-readings.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: tenant(1) });
  await setBilling(true);
}, 120_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  beforePin = null;
  await cleanup();
}, 120_000);

describe.skipIf(shouldSkip())("POST /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings (live database, through the GUI host)", () => {
  it("prepares the confirmation and the readings form, without writing", async () => {
    caller = manager;
    const before = await bills();
    const res = await prepare(DRAFT, tenant(1));
    expect(res.status).toBe(200);
    const prepared = (await res.json()) as PreparedAction;
    expect(prepared).toMatchObject({
      confirm: "confirm",
      method: "POST",
      path: `/api/billing-periods/${DRAFT}/tenants/${tenant(1)}/bill-from-readings`,
      bound: {},
    });
    // The period and the tenant come from the path: the person types the readings and a reason.
    const input = prepared.spec.input as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(input.properties)).toEqual(["start_kwh", "end_kwh", "reason"]);
    expect(input.required).toEqual(["start_kwh", "end_kwh"]);
    const facts = Object.fromEntries(prepared.ceremony!.facts.map((f) => [f.label, f.value.text]));
    expect(facts).toEqual({ Tenant: "Unit 1", Period: "1 Oct 2026 – 31 Oct 2026", Meter: "No meter for this period" });
    expect(prepared.ceremony!.warnings).toEqual(["The readings are printed on the bill as entered. Check them against the meter."]);
    expect(await bills()).toEqual(before);
  });

  it("names an assignment gap in the confirmation", async () => {
    caller = manager;
    const prepared = (await (await prepare(DRAFT, tenant(2))).json()) as PreparedAction;
    expect(prepared.ceremony!.facts.find((f) => f.label === "Meter")?.value.text).toBe("Meter assignment gap in this period");
  });

  it.each([
    ["a tenant with a bill", DRAFT, 3, 409, BILL_FROM_READINGS_COPY.hasBill],
    ["a tenant of another microgrid of the organization", DRAFT, 4, 409, BILL_FROM_READINGS_COPY.otherMicrogrid],
    ["a closed period", CLOSED, 1, 409, BILL_FROM_READINGS_COPY.closed],
  ])("refuses to prepare it for %s", async (_label, periodId, n, status, message) => {
    caller = manager;
    const res = await prepare(periodId, tenant(n));
    expect(res.status).toBe(status);
    expect((await res.json()).message).toBe(message);
  });

  it("bills the tenant from the readings entered, through the host's invoke", async () => {
    caller = manager;
    const auditBefore = await auditRows();
    const prepared = (await (await prepare(DRAFT, tenant(1))).json()) as PreparedAction;
    const result = await invoke(prepared, READINGS, { level: "confirm" }, routeFetch);
    expect(result).toEqual({
      type: "result",
      ok: true,
      message: expect.stringMatching(
        new RegExp(`^Billed Unit 1 from the readings entered: 50\\.377\\skWh\\. The bill's total is UGX\\s${EXPECTED.totalAmount.toLocaleString("en-GB")}\\.$`),
      ),
    });

    const bill = (await bills()).get(tenant(1));
    expect(bill).toMatchObject({
      device_id: null,
      start_kwh: 100.123,
      end_kwh: 150.5,
      usage_kwh: 50.377,
      total_amount: EXPECTED.totalAmount,
      reading_source: "manual",
      payment_status: "unpaid",
      entered_by_user_id: manager.userId,
      manual_reason: READINGS.reason,
    });
    expect(bill!.tier_breakdown).toEqual(EXPECTED.tierBreakdown);
    expect(await pinned()).toBe(SCHEDULE);
    // One audit row, for the bill generated.
    const added = (await auditRows()).slice(auditBefore.length);
    expect(added).toEqual([{ billing_line_item_id: bill!.id, event_type: "line_item_generated" }]);
  });

  it("refuses a second submission, and writes nothing", async () => {
    caller = manager;
    const before = await bills();
    const auditBefore = await auditRows();
    const res = await submit(DRAFT, tenant(1), { start_kwh: 0, end_kwh: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BILL_FROM_READINGS_COPY.hasBill, reason: "has_bill" });
    expect(await bills()).toEqual(before);
    expect(await auditRows()).toHaveLength(auditBefore.length);
  });

  it("bills a tenant with a meter assignment gap", async () => {
    caller = manager;
    const res = await submit(DRAFT, tenant(2), { start_kwh: 10, end_kwh: 20 });
    expect(res.status).toBe(201);
    expect((await bills()).get(tenant(2))).toMatchObject({ reading_source: "manual", start_kwh: 10, end_kwh: 20, usage_kwh: 10, manual_reason: null });
  });

  it.each([
    ["a tenant with a bill", DRAFT, 3, 409, { error: BILL_FROM_READINGS_COPY.hasBill, reason: "has_bill" }],
    ["a tenant of another microgrid of the organization", DRAFT, 4, 409, { error: BILL_FROM_READINGS_COPY.otherMicrogrid, reason: "tenant_not_on_microgrid" }],
    ["a closed period", CLOSED, 1, 409, { error: BILL_FROM_READINGS_COPY.closed, reason: "period_closed" }],
  ])("refuses %s on the route, and writes nothing", async (_label, periodId, n, status, body) => {
    caller = manager;
    const before = await bills(periodId);
    const auditBefore = await auditRows(periodId);
    const res = await submit(periodId, tenant(n), { start_kwh: 1, end_kwh: 2 });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    expect(await bills(periodId)).toEqual(before);
    expect(await auditRows(periodId)).toHaveLength(auditBefore.length);
  });

  it("refuses readings that go backwards, and writes nothing", async () => {
    caller = manager;
    const res = await submit(RACE, tenant(1), { start_kwh: 20, end_kwh: 10 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "end_kwh", code: "invalid_body" });
    expect((await bills(RACE)).size).toBe(0);
  });

  it("refuses while billing is off, in prepare and on the route, and writes nothing", async () => {
    caller = manager;
    await setBilling(false);
    try {
      const prep = await prepare(RACE, tenant(1));
      expect(prep.status).toBe(409);
      expect((await prep.json()).message).toContain("Billing is disabled");
      const res = await submit(RACE, tenant(1), { start_kwh: 1, end_kwh: 2 });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "billing_disabled" });
      expect((await bills(RACE)).size).toBe(0);
    } finally {
      await setBilling(true);
    }
  });

  it.each([
    ["another organization's manager", () => other],
    ["a tenant-only account of the same organization", () => tenantUser],
  ])("finds nothing for %s, and writes nothing", async (_label, who) => {
    caller = who();
    expect((await prepare(RACE, tenant(1))).status).toBe(404);
    const res = await submit(RACE, tenant(1), { start_kwh: 1, end_kwh: 2 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Billing period not found.", reason: "not_found" });
    caller = manager;
    expect((await bills(RACE)).size).toBe(0);
  });

  it("answers 401 with no session, and writes nothing", async () => {
    caller = "anon";
    const res = await submit(RACE, tenant(1), { start_kwh: 1, end_kwh: 2 });
    expect(res.status).toBe(401);
    expect((await bills(RACE)).size).toBe(0);
  });

  it("leaves a bill that appears after the route's check as it is: the engine's own read finds it", async () => {
    caller = manager;
    beforePin = async () => {
      const svc = await serviceClient();
      const { error } = await svc.from("billing_line_items").insert(billRow(RACE, 2));
      if (error) throw new Error(`[bill-from-readings.db] billing_line_items: ${error.message}`);
    };
    const res = await submit(RACE, tenant(2), { start_kwh: 1, end_kwh: 2 });
    expect(beforePin).toBeNull();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BILL_FROM_READINGS_COPY.hasBill, reason: "has_bill" });
    expect((await bills(RACE)).get(tenant(2))).toMatchObject({ reading_source: "edge", usage_kwh: 30, total_amount: 15000, manual_reason: null });
    expect(await auditRows(RACE)).toEqual([]);
  });
});
