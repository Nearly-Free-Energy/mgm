/**
 * POST /api/billing-periods/[periodId]/generate-from-meters against a live
 * database, run through the GUI host the way a GUI runs it: POST
 * /api/gui/prepare for `billing.generate-from-meters`, whose confirmation
 * says what will be read from meters, then the body the host's invoke sends
 * (`{}`) to the route. Meters are read from a metering provider registered
 * on the runtime for this microgrid only.
 *
 * The first run bills the metered tenants with no bill (from the previous
 * period's end reading where there is one), rewrites an unpaid edge bill
 * with new figures, writes nothing for one that already has them, keeps a
 * manual bill, leaves paid, invoiced and refunded bills as they are, and
 * gives no bill to a tenant with no meter, an assignment gap or no meter
 * data, while a tenant with a bill and no meter keeps that bill; one audit
 * row per bill written. A second run writes nothing. A bill paid between
 * the run's read and its write is left as paid. A period closed while its
 * meters are read gets nothing written. A bill with a pending payment link
 * is recalculated, and when its total changes its link is cleared and an
 * open checkout of it waits for reconciliation, as the confirmation warns
 * and the result counts. A closed period, a
 * microgrid with no rate schedule, a period whose meters have no data,
 * billing turned off, another organization's manager, a tenant-only account
 * and no session are all refused, with nothing written.
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
/** Runs once, just before the run's first conditional write reaches the database. */
let beforeWrite: (() => Promise<void>) | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (caller === "anon") return createClient(LOCAL_SUPABASE_URL, testAnonKey() ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
    if (!caller) throw new Error("[generate-from-meters.db] no caller");
    const client = caller.client;
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "rpc") {
          return async (name: string, args?: Record<string, unknown>) => {
            if (name === "fn_regenerate_bill_with_audit" && beforeWrite) {
              const hook = beforeWrite;
              beforeWrite = null;
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

import { invoke } from "@/lib/gui/host/client/invoke";
import type { PreparedAction } from "@/lib/gui/host/server/prepare";
import { GENERATE_FROM_METERS_COPY } from "@/lib/billing/schemas";
import { getMgmRuntime } from "@/lib/runtime/root";
import { POST as prepareRoute } from "@/app/api/gui/prepare/route";
import { POST } from "../route";

const ORG = "e7a10000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7a10000-0000-4000-8000-000000000002";
const COMMUNITY = "e7a10000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e7a10000-0000-4000-8001-000000000002";
const MICROGRID = "e7a10000-0000-4000-8002-000000000001";
/** A microgrid with no rate schedule. */
const UNPRICED = "e7a10000-0000-4000-8002-000000000002";
const EDGE = "e7a10000-0000-4000-8009-000000000001";
const SCHEDULE = "e7a10000-0000-4000-8006-000000000001";
/** October: the period generated. */
const DRAFT = "e7a10000-0000-4000-8003-000000000001";
/** September: closed, with unit 1's last end reading. */
const CLOSED = "e7a10000-0000-4000-8003-000000000002";
/** November: for the bill paid while the run writes. */
const RACE = "e7a10000-0000-4000-8003-000000000003";
/** December: no meter has data for it. */
const NO_DATA = "e7a10000-0000-4000-8003-000000000004";
/** October on the microgrid with no rate schedule. */
const NO_TARIFF = "e7a10000-0000-4000-8003-000000000005";
/** January: closed while its meters are read. */
const CLOSES = "e7a10000-0000-4000-8003-000000000006";
/** February: bills with a pending payment link. */
const LINKED = "e7a10000-0000-4000-8003-000000000007";
const ATTEMPT = "e7a10000-0000-4000-800a-000000000001";
const MERCHANT = "e7a10000-0000-4000-800b-000000000001";
const tenant = (n: number) => `e7a10000-0000-4000-8004-${String(n).padStart(12, "0")}`;
const device = (n: number) => `e7a10000-0000-4000-8007-${String(n).padStart(12, "0")}`;
const bill = (n: number, period = 0) => `e7a10000-0000-4000-8005-${String(period * 100 + n).padStart(12, "0")}`;
const EMAIL = "generate-meters-db-manager@test.local";
const OTHER_EMAIL = "generate-meters-db-other@test.local";
const TENANT_EMAIL = "generate-meters-db-tenant@test.local";
const PROVIDER = "generate-from-meters-db";

let manager: TestUser;
let other: TestUser;
let tenantUser: TestUser;
let unregister: (() => void) | null = null;
/** The devices each read asked for. */
const reads: string[][] = [];
/** Runs once, while the meters are read. */
let duringRead: (() => Promise<void>) | null = null;

/**
 * 1 metered, no bill, an end reading of 500 in September; 2 metered, no
 * bill, no earlier reading; 3 metered, an unpaid edge bill of other figures;
 * 4 metered, an unpaid edge bill with the meter's figures; 5 a manual bill;
 * 6 a paid bill; 7 an invoiced bill; 8 a refunded bill; 9 no meter; 10 a
 * meter assigned only after the period began; 11 a meter with no data; 12
 * no meter and an unpaid edge bill. 20 is on the microgrid with no rate
 * schedule.
 */
const METERED = [1, 2, 3, 4, 5, 6, 7, 8, 11];
const USAGE = 40;
/** 40 kWh: 15 at 250 (3,750) and 25 at 750 (18,750). */
const TIERS_40 = [
  { label: "Lifeline", kwh: 15, amount: 3750 },
  { label: "Standard", kwh: 25, amount: 18750 },
];
const TOTAL_40 = 22500;

const row = (n: number, o: Record<string, unknown> = {}) => ({
  id: bill(n),
  billing_period_id: DRAFT,
  tenant_id: tenant(n),
  device_id: device(n),
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
  paid_at: null,
  invoice_number: null,
  manual_reason: null,
  ...o,
});

const generate = (periodId: string, body: unknown = {}) =>
  POST(
    new NextRequest(`http://localhost/api/billing-periods/${periodId}/generate-from-meters`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en-GB" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ periodId }) },
  );
const prepare = (periodId: string) =>
  prepareRoute(
    new NextRequest("http://localhost/api/gui/prepare", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en-GB" },
      body: JSON.stringify({ action: "billing.generate-from-meters", params: { periodId } }),
    }),
  );
/** What a GUI's fetch does with the host's write: the route, as Next.js would route it. */
const routeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  const match = /^\/api\/billing-periods\/([^/]+)\/generate-from-meters$/.exec(url);
  if (!match || init.method !== "POST") throw new Error(`[generate-from-meters.db] unexpected write ${init.method} ${url}`);
  return generate(match[1], JSON.parse(init.body as string));
};

async function setBilling(enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc
    .from("mgm_plugins")
    .upsert({ org_id: ORG, plugin_name: "billing", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[generate-from-meters.db] mgm_plugins: ${error.message}`);
}

type Bill = {
  id: string;
  tenant_id: string;
  start_kwh: number | null;
  end_kwh: number | null;
  usage_kwh: number | null;
  total_amount: number;
  payment_status: string;
  reading_source: string;
  invoice_number: string | null;
  tier_breakdown: unknown;
};

async function bills(periodId = DRAFT): Promise<Map<string, Bill>> {
  const svc = await serviceClient();
  const { data, error } = await svc
    .from("billing_line_items")
    .select("id, tenant_id, start_kwh, end_kwh, usage_kwh, total_amount, payment_status, reading_source, invoice_number, tier_breakdown")
    .eq("billing_period_id", periodId);
  if (error) throw new Error(`[generate-from-meters.db] bills: ${error.message}`);
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
  if (error) throw new Error(`[generate-from-meters.db] billing_audit_log: ${error.message}`);
  return (data ?? []) as { billing_line_item_id: string | null; event_type: string }[];
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
    ["organizations", [{ id: ORG, name: "Generate Meters DB Org" }, { id: OTHER_ORG, name: "Generate Meters DB Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "Generate Meters DB Community", invoice_prefix: "GMD" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "Generate Meters DB Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "Generate site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: UNPRICED, community_id: COMMUNITY, name: "Unpriced site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    [
      "rate_schedules",
      {
        id: SCHEDULE,
        microgrid_id: MICROGRID,
        tiers: [
          { label: "Lifeline", min_kwh: 1, max_kwh: 15, rate_per_kwh: 250 },
          { label: "Standard", min_kwh: 16, max_kwh: null, rate_per_kwh: 750 },
        ],
        service_charge: 0,
        tax_rate: 0,
      },
    ],
    ["edges", { id: EDGE, microgrid_id: MICROGRID, name: "Generate edge", openems_edge_id: "generate-meters-edge" }],
    [
      "devices",
      [...METERED, 10].map((n) => ({ id: device(n), edge_id: EDGE, name: `Meter ${n}`, device_type: "consumption_meter", openems_component_id: `meter${n}` })),
    ],
    [
      "tenants",
      [
        ...Array.from({ length: 12 }, (_, i) => i + 1).map((n) => ({ id: tenant(n), microgrid_id: MICROGRID, display_name: `Unit ${n}`, primary_phone: `+2567000009${String(n).padStart(2, "0")}` })),
        { id: tenant(20), microgrid_id: UNPRICED, display_name: "Unit 20", primary_phone: "+256700000920" },
      ],
    ],
    [
      "tenant_devices",
      [
        ...METERED.map((n) => ({ tenant_id: tenant(n), device_id: device(n), role: "primary_consumption_meter", effective_from: "2026-01-01" })),
        { tenant_id: tenant(10), device_id: device(10), role: "primary_consumption_meter", effective_from: "2026-10-15" },
      ],
    ],
    [
      "billing_periods",
      [
        { id: DRAFT, microgrid_id: MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala", status: "draft", closed_at: null, rate_schedule_id: SCHEDULE },
        { id: CLOSED, microgrid_id: MICROGRID, start_date: "2026-09-01", end_date: "2026-09-30", timezone: "Africa/Kampala", status: "closed", closed_at: closedAt, rate_schedule_id: SCHEDULE },
        { id: RACE, microgrid_id: MICROGRID, start_date: "2026-11-01", end_date: "2026-11-30", timezone: "Africa/Kampala", status: "draft", closed_at: null, rate_schedule_id: SCHEDULE },
        { id: NO_DATA, microgrid_id: MICROGRID, start_date: "2026-12-01", end_date: "2026-12-31", timezone: "Africa/Kampala", status: "draft", closed_at: null, rate_schedule_id: SCHEDULE },
        { id: NO_TARIFF, microgrid_id: UNPRICED, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala", status: "draft", closed_at: null, rate_schedule_id: null },
        { id: CLOSES, microgrid_id: MICROGRID, start_date: "2027-01-01", end_date: "2027-01-31", timezone: "Africa/Kampala", status: "draft", closed_at: null, rate_schedule_id: SCHEDULE },
        { id: LINKED, microgrid_id: MICROGRID, start_date: "2027-02-01", end_date: "2027-02-28", timezone: "Africa/Kampala", status: "draft", closed_at: null, rate_schedule_id: SCHEDULE },
      ],
    ],
    [
      "billing_line_items",
      [
        // September's: unit 1's meter ended at 500.
        row(1, { id: bill(1, 9), billing_period_id: CLOSED, start_kwh: 470, end_kwh: 500 }),
        row(3),
        row(4, { usage_kwh: USAGE, tier_breakdown: TIERS_40, total_amount: TOTAL_40 }),
        row(5, { reading_source: "manual", start_kwh: 10, end_kwh: 40, manual_reason: "dial photo" }),
        row(6, { payment_status: "paid", paid_at: closedAt }),
        row(7, { invoice_number: "GMD-2025-00001" }),
        row(8, { payment_status: "refunded", paid_at: closedAt }),
        row(12, { device_id: null }),
        // November's: unit 3, paid while the run writes.
        row(3, { id: bill(3, 11), billing_period_id: RACE }),
        // January's: unit 3, in a period closed while its meters are read.
        row(3, { id: bill(3, 1), billing_period_id: CLOSES }),
        // February's: pending payment links on unit 3's bill, of other
        // figures, and on unit 4's, with the meter's.
        row(3, { id: bill(3, 2), billing_period_id: LINKED, payment_status: "link_generated", pesapal_order_id: "order-3", pesapal_redirect_url: "https://pay.test/3" }),
        row(4, {
          id: bill(4, 2),
          billing_period_id: LINKED,
          usage_kwh: USAGE,
          tier_breakdown: TIERS_40,
          total_amount: TOTAL_40,
          payment_status: "link_generated",
          pesapal_order_id: "order-4",
          pesapal_redirect_url: "https://pay.test/4",
        }),
      ],
    ],
    // A merchant account with no credentials, for the checkout below.
    ["payment_merchant_accounts", { id: MERCHANT, org_id: ORG, display_name: "Generate Meters DB account" }],
    [
      "payment_attempts",
      // A checkout started on unit 3's February bill.
      {
        id: ATTEMPT,
        org_id: ORG,
        line_item_id: bill(3, 2),
        community_id: COMMUNITY,
        merchant_account_id: MERCHANT,
        amount: 15000,
        currency: "UGX",
        bill_revision_total: 15000,
        merchant_reference: "generate-meters-db-attempt",
      },
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[generate-from-meters.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: tenant(1) });
  await setBilling(true);

  // This microgrid's meters: 40 kWh each, and no data for unit 11's, nor for any in December.
  const runtime = await getMgmRuntime();
  unregister = runtime.meteringProviders.register(
    PROVIDER,
    () => ({
      getReadings: async ({ devices, startDate, endDate }) => {
        reads.push(devices.map((d) => d.id).sort());
        if (duringRead) {
          const hook = duringRead;
          duringRead = null;
          await hook();
        }
        return devices.map((d) => ({ deviceId: d.id, usageKwh: d.id === device(11) || startDate.startsWith("2026-12") ? null : USAGE, startDate, endDate }));
      },
    }),
    { supports: async (_client, microgridId) => microgridId === MICROGRID },
  );
}, 120_000);

afterAll(async () => {
  if (shouldSkip()) return;
  unregister?.();
  caller = null;
  beforeWrite = null;
  duringRead = null;
  await cleanup();
}, 120_000);

describe.skipIf(shouldSkip())("POST /api/billing-periods/[periodId]/generate-from-meters (live database, through the GUI host)", () => {
  it("prepares the confirmation from what the run will read, without reading a meter or writing", async () => {
    caller = manager;
    const before = await bills();
    const res = await prepare(DRAFT);
    expect(res.status).toBe(200);
    const prepared = (await res.json()) as PreparedAction;
    expect(prepared).toMatchObject({ confirm: "confirm", method: "POST", path: `/api/billing-periods/${DRAFT}/generate-from-meters`, bound: {} });
    const facts = Object.fromEntries(prepared.ceremony!.facts.map((f) => [f.label, f.value.text]));
    expect(facts).toMatchObject({
      "Read from meters": "5",
      "Of these, already billed": "2",
      "Kept, entered by hand": "1",
      "Left as they are: paid, invoiced or refunded": "3",
      "Not billed: no meter for the period": "1",
      "Not billed: a meter assignment gap": "1",
      "Bill left as it is, not refreshed: no meter for the period": "1",
    });
    // Each by the reason the result gives, and a bill with no meter is left, not unbilled.
    expect(prepared.ceremony!.warnings.slice(0, 3)).toEqual([
      "No meter for this period, so not billed: Unit 9.",
      "A meter assignment gap in this period (no one meter assigned for all of it), so not billed: Unit 10.",
      "No meter for this period, so their bills are left as they are, not refreshed: Unit 12.",
    ]);
    expect(reads).toEqual([]);
    expect(await bills()).toEqual(before);
  });

  it("generates the period's bills through the host's invoke, as the confirmation said", async () => {
    caller = manager;
    const before = await bills();
    const auditBefore = await auditRows();
    const prepared = (await (await prepare(DRAFT)).json()) as PreparedAction;
    const result = await invoke(prepared, null, { level: "confirm" }, routeFetch);
    expect(result).toEqual({
      type: "result",
      ok: true,
      message:
        "Generated 3 bills from meter data; 1 already up to date. Not billed: 1 with no meter, 1 with a meter assignment gap, 1 with no meter data. Left as they were: 1 entered by hand, 3 paid, invoiced or refunded, 1 not refreshed.",
    });
    // Only the meters of tenants it may bill were read.
    expect(reads.at(-1)).toEqual([1, 2, 3, 4, 11].map(device).sort());

    const after = await bills();
    // A first bill from the previous period's end reading, and one with blank readings.
    expect(after.get(tenant(1))).toMatchObject({ start_kwh: 500, end_kwh: 540, usage_kwh: USAGE, total_amount: TOTAL_40, reading_source: "edge" });
    expect(after.get(tenant(2))).toMatchObject({ start_kwh: null, end_kwh: null, usage_kwh: USAGE, total_amount: TOTAL_40 });
    // An unpaid edge bill rewritten with the meter's figures.
    expect(after.get(tenant(3))).toMatchObject({ id: bill(3), usage_kwh: USAGE, total_amount: TOTAL_40, payment_status: "unpaid" });
    // Kept, left, already up to date or with no meter to read: as they were.
    for (const n of [4, 5, 6, 7, 8, 12]) expect(after.get(tenant(n)), `unit ${n}`).toEqual(before.get(tenant(n)));
    // No meter, an assignment gap, no meter data: no bill, and no zero placeholder.
    for (const n of [9, 10, 11]) expect(after.has(tenant(n)), `unit ${n}`).toBe(false);

    // One audit row for each bill written, and none for the one already up to date.
    const added = (await auditRows()).slice(auditBefore.length);
    expect(added).toHaveLength(3);
    expect(new Set(added.map((a) => a.billing_line_item_id))).toEqual(new Set([after.get(tenant(1))!.id, after.get(tenant(2))!.id, bill(3)]));
  });

  it("writes nothing on a second run", async () => {
    caller = manager;
    const before = await bills();
    const auditBefore = await auditRows();
    const res = await generate(DRAFT);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      generated: 0,
      unchanged: 4,
      kept: 1,
      left: 3,
      changed: 0,
      notRefreshed: 1,
      notBilled: { noMeter: 1, meterAssignment: 1, noReading: 1, failed: 0 },
    });
    expect(body.tenants).toContainEqual({ tenantId: tenant(12), tenantName: "Unit 12", outcome: "left", code: "unmetered_no_manual" });
    expect(body.message).toBe(
      "Nothing changed: 4 bills already have the latest meter figures. Not billed: 1 with no meter, 1 with a meter assignment gap, 1 with no meter data. Left as they were: 1 entered by hand, 3 paid, invoiced or refunded, 1 not refreshed.",
    );
    expect(await bills()).toEqual(before);
    expect(await auditRows()).toHaveLength(auditBefore.length);
  });

  it("leaves a bill paid between the run's read and its write as paid, and writes the others", async () => {
    caller = manager;
    beforeWrite = async () => {
      const svc = await serviceClient();
      // A Pesapal notification, as the payment path records it.
      const { error } = await svc.rpc("fn_apply_payment_event", {
        _line_item_id: bill(3, 11),
        _to_status: "paid",
        _source: "ipn",
        _actor_user_id: null,
        _raw_payload: null,
        _actor_kind: "system",
        _actor_ref: "pesapal_ipn",
      });
      if (error) throw new Error(`[generate-from-meters.db] fn_apply_payment_event: ${error.message}`);
    };
    const res = await generate(RACE);
    expect(beforeWrite).toBeNull();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ changed: 1 });
    expect(body.tenants).toContainEqual({ tenantId: tenant(3), tenantName: "Unit 3", outcome: "left", code: "bill_changed" });
    expect(body.message).toContain("1 changed meanwhile");
    const after = await bills(RACE);
    expect(after.get(tenant(3))).toMatchObject({ payment_status: "paid", usage_kwh: 30, total_amount: 15000 });
    expect(after.get(tenant(1))).toMatchObject({ usage_kwh: USAGE, total_amount: TOTAL_40 });
  });

  it("refuses a closed period, in prepare and on the route, and writes nothing", async () => {
    caller = manager;
    const before = await bills(CLOSED);
    const prep = await prepare(CLOSED);
    expect(prep.status).toBe(409);
    expect((await prep.json()).message).toBe(GENERATE_FROM_METERS_COPY.closed);
    const res = await generate(CLOSED);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: GENERATE_FROM_METERS_COPY.closed, reason: "period_closed" });
    expect(await bills(CLOSED)).toEqual(before);
  });

  it("refuses a period closed while its meters are read, and writes nothing", async () => {
    caller = manager;
    const before = await bills(CLOSES);
    const auditBefore = await auditRows(CLOSES);
    duringRead = async () => {
      const svc = await serviceClient();
      const { error } = await svc.from("billing_periods").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", CLOSES);
      if (error) throw new Error(`[generate-from-meters.db] close: ${error.message}`);
    };
    const res = await generate(CLOSES);
    expect(duringRead).toBeNull();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: GENERATE_FROM_METERS_COPY.closed, reason: "period_closed" });
    // Neither unit 3's bill rewritten nor the others' first bills inserted.
    expect(await bills(CLOSES)).toEqual(before);
    expect(await auditRows(CLOSES)).toHaveLength(auditBefore.length);
  });

  it("warns of pending payment links, and says which stopped working as their bill's total changed", async () => {
    caller = manager;
    const prepared = (await (await prepare(LINKED)).json()) as PreparedAction;
    const facts = Object.fromEntries(prepared.ceremony!.facts.map((f) => [f.label, f.value.text]));
    expect(facts).toMatchObject({ "Of these, already billed": "2", "Of these, with a pending payment link": "2" });
    expect(prepared.ceremony!.warnings).toContain(
      "2 bills to be recalculated have a pending payment link. Where a bill's total changes, its link stops working and the tenant needs a new one.",
    );
    expect(prepared.ceremony!.warnings).toContain(
      "If a bill's total changes, a payment already started for it is held for reconciliation instead of marking the bill paid.",
    );

    const res = await generate(LINKED);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ paymentLinksCleared: 1, unchanged: 1 });
    expect(body.message).toContain("1 payment link stopped working, as its bill's total changed.");

    const svc = await serviceClient();
    const { data: links, error } = await svc
      .from("billing_line_items")
      .select("id, total_amount, payment_status, pesapal_order_id, pesapal_redirect_url")
      .in("id", [bill(3, 2), bill(4, 2)]);
    if (error) throw new Error(`[generate-from-meters.db] links: ${error.message}`);
    const byId = new Map((links ?? []).map((l) => [l.id, l]));
    // A new total: the link is cleared; the payment status is the payment path's, as before.
    expect(byId.get(bill(3, 2))).toMatchObject({ total_amount: TOTAL_40, payment_status: "link_generated", pesapal_order_id: null, pesapal_redirect_url: null });
    // The meter's figures already: not written, the link kept.
    expect(byId.get(bill(4, 2))).toMatchObject({ payment_status: "link_generated", pesapal_order_id: "order-4", pesapal_redirect_url: "https://pay.test/4" });
    // The checkout started on unit 3's bill waits for reconciliation.
    const { data: attempt } = await svc.from("payment_attempts").select("status, failure_code").eq("id", ATTEMPT).single();
    expect(attempt).toEqual({ status: "needs_reconciliation", failure_code: "bill_revised" });
  });

  it("refuses a microgrid with no rate schedule as no_tariff, through the real engine, and writes nothing", async () => {
    caller = manager;
    const auditBefore = await auditRows(NO_TARIFF);
    const res = await generate(NO_TARIFF);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: GENERATE_FROM_METERS_COPY.noTariff, reason: "no_tariff" });
    expect((await bills(NO_TARIFF)).size).toBe(0);
    expect(await auditRows(NO_TARIFF)).toHaveLength(auditBefore.length);
  });

  it("answers 409 nothing_generated with the summary when no meter has data, and writes nothing", async () => {
    caller = manager;
    const res = await generate(NO_DATA);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      reason: "nothing_generated",
      generated: 0,
      unchanged: 0,
      notRefreshed: 0,
      notBilled: { noMeter: 2, meterAssignment: 0, noReading: 10, failed: 0 },
    });
    expect(body.error).toBe("No bill was generated. Not billed: 2 with no meter, 10 with no meter data.");
    expect(body.message).toBe(body.error);
    expect((await bills(NO_DATA)).size).toBe(0);
    expect(await auditRows(NO_DATA)).toHaveLength(0);
  });

  it("refuses while billing is off, in prepare and on the route, and writes nothing", async () => {
    caller = manager;
    await setBilling(false);
    try {
      const before = await bills();
      const prep = await prepare(DRAFT);
      expect(prep.status).toBe(409);
      expect((await prep.json()).message).toContain("Billing is disabled");
      const res = await generate(DRAFT);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "billing_disabled" });
      expect(await bills()).toEqual(before);
    } finally {
      await setBilling(true);
    }
  });

  it.each([
    ["another organization's manager", () => other],
    ["a tenant-only account of the same organization", () => tenantUser],
  ])("finds nothing for %s, and writes nothing", async (_label, who) => {
    caller = who();
    const before = await bills();
    expect((await prepare(DRAFT)).status).toBe(404);
    const res = await generate(DRAFT);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Billing period not found.", reason: "not_found" });
    caller = manager;
    expect(await bills()).toEqual(before);
  });

  it("answers 401 with no session", async () => {
    caller = "anon";
    const res = await generate(DRAFT);
    expect(res.status).toBe(401);
  });
});
