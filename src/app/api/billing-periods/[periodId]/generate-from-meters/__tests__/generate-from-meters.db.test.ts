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
 * data; one audit row per bill written. A second run writes nothing. A bill
 * paid between the run's read and its write is left as paid. A closed
 * period, billing turned off, another organization's manager, a tenant-only
 * account and no session are all refused, with nothing written.
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
const EDGE = "e7a10000-0000-4000-8009-000000000001";
const SCHEDULE = "e7a10000-0000-4000-8006-000000000001";
/** October: the period generated. */
const DRAFT = "e7a10000-0000-4000-8003-000000000001";
/** September: closed, with unit 1's last end reading. */
const CLOSED = "e7a10000-0000-4000-8003-000000000002";
/** November: for the bill paid while the run writes. */
const RACE = "e7a10000-0000-4000-8003-000000000003";
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

/**
 * 1 metered, no bill, an end reading of 500 in September; 2 metered, no
 * bill, no earlier reading; 3 metered, an unpaid edge bill of other figures;
 * 4 metered, an unpaid edge bill with the meter's figures; 5 a manual bill;
 * 6 a paid bill; 7 an invoiced bill; 8 a refunded bill; 9 no meter; 10 a
 * meter assigned only after the period began; 11 a meter with no data.
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
    ["microgrids", { id: MICROGRID, community_id: COMMUNITY, name: "Generate site", currency: "UGX", timezone: "Africa/Kampala" }],
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
      Array.from({ length: 11 }, (_, i) => i + 1).map((n) => ({ id: tenant(n), microgrid_id: MICROGRID, display_name: `Unit ${n}`, primary_phone: `+2567000009${String(n).padStart(2, "0")}` })),
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
        // November's: unit 3, paid while the run writes.
        row(3, { id: bill(3, 11), billing_period_id: RACE }),
      ],
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

  // This microgrid's meters: 40 kWh each, and no data for unit 11's.
  const runtime = await getMgmRuntime();
  unregister = runtime.meteringProviders.register(
    PROVIDER,
    () => ({
      getReadings: async ({ devices, startDate, endDate }) => {
        reads.push(devices.map((d) => d.id).sort());
        return devices.map((d) => ({ deviceId: d.id, usageKwh: d.id === device(11) ? null : USAGE, startDate, endDate }));
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
      "Not billed: no meter for the period": "2",
    });
    expect(prepared.ceremony!.warnings[0]).toBe("No meter for this period, so not billed: Unit 10, Unit 9.");
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
        "Generated 3 bills from meter data; 1 was already up to date. Not billed from meters: 1 with no meter, 1 with a meter assignment gap, 1 with no meter data. Left as they were: 1 entered by hand, 3 paid, invoiced or refunded.",
    });
    // Only the meters of tenants it may bill were read.
    expect(reads.at(-1)).toEqual([1, 2, 3, 4, 11].map(device).sort());

    const after = await bills();
    // A first bill from the previous period's end reading, and one with blank readings.
    expect(after.get(tenant(1))).toMatchObject({ start_kwh: 500, end_kwh: 540, usage_kwh: USAGE, total_amount: TOTAL_40, reading_source: "edge" });
    expect(after.get(tenant(2))).toMatchObject({ start_kwh: null, end_kwh: null, usage_kwh: USAGE, total_amount: TOTAL_40 });
    // An unpaid edge bill rewritten with the meter's figures.
    expect(after.get(tenant(3))).toMatchObject({ id: bill(3), usage_kwh: USAGE, total_amount: TOTAL_40, payment_status: "unpaid" });
    // Kept, left or already up to date: as they were.
    for (const n of [4, 5, 6, 7, 8]) expect(after.get(tenant(n)), `unit ${n}`).toEqual(before.get(tenant(n)));
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
    expect(body).toMatchObject({ generated: 0, unchanged: 4, kept: 1, left: 3, changed: 0, notBilled: { noMeter: 1, meterAssignment: 1, noReading: 1, failed: 0 } });
    expect(body.message).toBe(
      "Nothing changed: 4 bills already have the latest meter figures. Not billed from meters: 1 with no meter, 1 with a meter assignment gap, 1 with no meter data. Left as they were: 1 entered by hand, 3 paid, invoiced or refunded.",
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
