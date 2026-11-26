/**
 * POST /api/payments/attempts/[id]/reconcile against the database, as an
 * organization manager (not a super admin), with the person's own session:
 * the body is parsed first; a completed adjustment needs the tenant's name
 * typed and an amount that settles the bill exactly, and then marks the
 * bill paid, resolves the attempt and records a payment event with the
 * person as its actor; accepting exact receipts does the same without an
 * amount; another organization's manager and a tenant are refused; and
 * fn_payment_reconcile's own refusals of a bill with a checkout whose
 * outcome is unknown, or with receipts in another currency, reach the
 * person as fixed copy, so a reworded RAISE fails here rather than turning
 * into a 500. Accepting exact receipts and recording a completed adjustment
 * both work while Payments is off, as the route's PaymentExemption and the
 * GUI's whilePluginOff declarations say.
 * Refresh status is not called here: it would ask the provider.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    if (!caller) throw new Error("[reconcile.db] no caller");
    return caller.client;
  },
}));

import { RECONCILE_COPY } from "@/lib/payments/schemas";
import { POST } from "../reconcile/route";

const ORG = "e8700000-0000-4000-8000-000000000001";
const OTHER_ORG = "e8700000-0000-4000-8000-000000000002";
const COMMUNITY = "e8700000-0000-4000-8001-000000000001";
const MICROGRID = "e8700000-0000-4000-8002-000000000001";
const SCHEDULE = "e8700000-0000-4000-8006-000000000001";
const MERCHANT = "e8700000-0000-4000-8007-000000000001";
const PERIOD = "e8700000-0000-4000-8003-000000000001";
const tenant = (n: number) => `e8700000-0000-4000-8004-00000000000${n}`;
const BILL_A = "e8700000-0000-4000-8005-000000000001";
const BILL_B = "e8700000-0000-4000-8005-000000000002";
/** Bill A (5,000): held, with a receipt of 3,000. */
const A_HELD = "e8700000-0000-4000-8008-000000000001";
/** Bill B (3,000): held, with a receipt of exactly 3,000. */
const B_HELD = "e8700000-0000-4000-8008-000000000002";
const BILL_C = "e8700000-0000-4000-8005-000000000003";
const BILL_D = "e8700000-0000-4000-8005-000000000004";
/** Bill C (4,000): held, with a receipt of exactly 4,000, beside a pending checkout with no tracking id. */
const C_HELD = "e8700000-0000-4000-8008-000000000003";
const C_UNKNOWN = "e8700000-0000-4000-8008-000000000004";
/** Bill D (2,000): held, with a receipt of exactly 2,000 and another in USD. */
const D_HELD = "e8700000-0000-4000-8008-000000000005";
const BILL_E = "e8700000-0000-4000-8005-000000000005";
/** Bill E (1,500): held, with a receipt of exactly 1,500, reconciled while Payments is off. */
const E_HELD = "e8700000-0000-4000-8008-000000000006";
const BILL_F = "e8700000-0000-4000-8005-000000000006";
/** Bill F (2,500): held, with a receipt of 1,000, settled by a completed adjustment while Payments is off. */
const F_HELD = "e8700000-0000-4000-8008-000000000007";
const EMAIL = "attempts-reconcile-manager@test.local";
const OTHER_EMAIL = "attempts-reconcile-other@test.local";
const TENANT_EMAIL = "attempts-reconcile-tenant@test.local";

let manager: TestUser;
let other: TestUser;
let tenantUser: TestUser;
let fetchSpy: { mock: { calls: Parameters<typeof fetch>[] }; mockRestore(): void };

const reconcile = async (attemptId: string, body: unknown) => {
  const res = await POST(
    new NextRequest(`http://localhost/api/payments/attempts/${attemptId}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: attemptId }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const record = (o: { amount?: number; typed?: string } = {}) => ({
  action: "record_external",
  externalAmount: o.amount ?? 2000,
  externalReference: "MTN-CASH-1",
  notes: "Collected in cash by the manager",
  ...(o.typed === undefined ? {} : { confirmation: { acknowledged: [], typed: o.typed } }),
});

// payment_merchant_versions references organizations without ON DELETE
// CASCADE, so its rows go first; payment records are kept with their bill
// (20261103160000), so cleanupTestData purges the organization as the
// database owner.
async function cleanup() {
  const svc = await serviceClient();
  const plugins = await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  if (plugins.error) throw new Error(`[reconcile.db] mgm_plugins: ${plugins.error.message}`);
  const { error } = await svc.from("payment_merchant_versions").delete().in("org_id", [ORG, OTHER_ORG]);
  if (error) throw new Error(`[reconcile.db] payment_merchant_versions: ${error.message}`);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, OTHER_EMAIL, TENANT_EMAIL] });
}

const attempt = (id: string, lineItem: string, amount: number, tracking: string | null, status = "needs_reconciliation") => ({
  id,
  org_id: ORG,
  line_item_id: lineItem,
  community_id: COMMUNITY,
  merchant_account_id: MERCHANT,
  merchant_account_version: 1,
  amount,
  currency: "UGX",
  bill_revision_total: amount,
  merchant_reference: `MGM-${id}`,
  provider_tracking_id: tracking,
  status,
  failure_code: status === "needs_reconciliation" ? "balance_mismatch" : null,
});
const receipt = (attemptId: string, amount: number, tracking: string, currency = "UGX") => ({
  org_id: ORG,
  attempt_id: attemptId,
  amount,
  currency,
  provider: "pesapal",
  provider_status: "completed",
  provider_tracking_id: tracking,
  raw_payload: {},
});

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // The route looks the attempt up, and Payments builds its repository, with
  // a service-role client (src/lib/supabase/service.ts): SUPABASE_SERVICE_ROLE_KEY
  // and the server URL, where SUPABASE_INTERNAL_URL wins over
  // MGM_PUBLIC_SUPABASE_URL. If that file reads other names, revisit.
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  fetchSpy = vi.spyOn(globalThis, "fetch");
  await cleanup();
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "Reconcile Org" }, { id: OTHER_ORG, name: "Reconcile Other Org" }]],
    ["communities", { id: COMMUNITY, org_id: ORG, name: "Reconcile Community" }],
    ["microgrids", { id: MICROGRID, community_id: COMMUNITY, name: "Reconcile site", currency: "UGX", timezone: "Africa/Kampala" }],
    ["rate_schedules", { id: SCHEDULE, microgrid_id: MICROGRID, tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }], service_charge: 0, tax_rate: 0 }],
    [
      "tenants",
      [
        { id: tenant(1), microgrid_id: MICROGRID, display_name: "Akello  Grace", primary_phone: "+256700000901" },
        { id: tenant(2), microgrid_id: MICROGRID, display_name: "Byaruhanga Peter", primary_phone: "+256700000902" },
        { id: tenant(3), microgrid_id: MICROGRID, display_name: "Kato Joseph", primary_phone: "+256700000903" },
        { id: tenant(4), microgrid_id: MICROGRID, display_name: "Nambi Ruth", primary_phone: "+256700000904" },
        { id: tenant(5), microgrid_id: MICROGRID, display_name: "Okello James", primary_phone: "+256700000905" },
        { id: tenant(6), microgrid_id: MICROGRID, display_name: "Atim Sarah", primary_phone: "+256700000906" },
      ],
    ],
    ["billing_periods", { id: PERIOD, microgrid_id: MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", status: "draft", timezone: "Africa/Kampala", rate_schedule_id: SCHEDULE }],
    [
      "billing_line_items",
      [
        { id: BILL_A, billing_period_id: PERIOD, tenant_id: tenant(1), start_kwh: 0, end_kwh: 10, usage_kwh: 10, total_amount: 5000, reading_source: "manual" },
        { id: BILL_B, billing_period_id: PERIOD, tenant_id: tenant(2), start_kwh: 0, end_kwh: 6, usage_kwh: 6, total_amount: 3000, reading_source: "manual" },
        { id: BILL_C, billing_period_id: PERIOD, tenant_id: tenant(3), start_kwh: 0, end_kwh: 8, usage_kwh: 8, total_amount: 4000, reading_source: "manual" },
        { id: BILL_D, billing_period_id: PERIOD, tenant_id: tenant(4), start_kwh: 0, end_kwh: 4, usage_kwh: 4, total_amount: 2000, reading_source: "manual" },
        { id: BILL_E, billing_period_id: PERIOD, tenant_id: tenant(5), start_kwh: 0, end_kwh: 3, usage_kwh: 3, total_amount: 1500, reading_source: "manual" },
        { id: BILL_F, billing_period_id: PERIOD, tenant_id: tenant(6), start_kwh: 0, end_kwh: 5, usage_kwh: 5, total_amount: 2500, reading_source: "manual" },
      ],
    ],
    ["payment_merchant_accounts", { id: MERCHANT, org_id: ORG, provider: "pesapal", is_default: true, sandbox: true, last_test_status: "success", ipn_id: "ipn-test" }],
    [
      "payment_attempts",
      [
        attempt(A_HELD, BILL_A, 5000, "trk-a"),
        attempt(B_HELD, BILL_B, 3000, "trk-b"),
        attempt(C_HELD, BILL_C, 4000, "trk-c"),
        attempt(C_UNKNOWN, BILL_C, 4000, null, "pending"),
        attempt(D_HELD, BILL_D, 2000, "trk-d"),
        attempt(E_HELD, BILL_E, 1500, "trk-e"),
        attempt(F_HELD, BILL_F, 2500, "trk-f"),
      ],
    ],
    [
      "payment_receipts",
      [
        receipt(A_HELD, 3000, "trk-a"),
        receipt(B_HELD, 3000, "trk-b"),
        receipt(C_HELD, 4000, "trk-c"),
        receipt(D_HELD, 2000, "trk-d"),
        receipt(D_HELD, 1, "trk-d-usd", "USD"),
        receipt(E_HELD, 1500, "trk-e"),
        receipt(F_HELD, 1000, "trk-f"),
      ],
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[reconcile.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: tenant(1) });
}, 120_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
  fetchSpy?.mockRestore();
  vi.unstubAllEnvs();
}, 120_000);

/**
 * Runs `run` with Payments turned off for ORG, and turns it back on after,
 * failing loudly if either write fails, so a failed cleanup cannot leave
 * Payments off for the cases after it.
 */
async function whilePaymentsOff(run: () => Promise<void>) {
  const svc = await serviceClient();
  const off = await svc.from("mgm_plugins").upsert({ org_id: ORG, plugin_name: "payments", version: "0.1.0", enabled: false }, { onConflict: "org_id,plugin_name" });
  if (off.error) throw new Error(`[reconcile.db] mgm_plugins: ${off.error.message}`);
  try {
    await run();
  } finally {
    const on = await svc.from("mgm_plugins").delete().eq("org_id", ORG);
    if (on.error) throw new Error(`[reconcile.db] mgm_plugins: ${on.error.message}`);
  }
}

async function state(billId: string, attemptId: string) {
  const svc = await serviceClient();
  const [billRes, attemptRes, events] = await Promise.all([
    svc.from("billing_line_items").select("payment_status").eq("id", billId).single(),
    svc.from("payment_attempts").select("status, resolved_by").eq("id", attemptId).single(),
    svc.from("payment_events").select("source, actor_kind, actor_user_id, to_status, raw_payload").eq("line_item_id", billId),
  ]);
  return { bill: billRes.data?.payment_status, attempt: attemptRes.data, events: events.data ?? [] };
}

describe.skipIf(shouldSkip())("POST /api/payments/attempts/[id]/reconcile on the database", () => {
  it("refuses a body that does not parse before anything else", async () => {
    caller = manager;
    expect(await reconcile(A_HELD, { ...record({ typed: "Akello Grace" }), attemptId: A_HELD })).toEqual({
      status: 400,
      body: { error: "Unknown field: attemptId", code: "invalid_body" },
    });
  });

  it.each([
    ["another organization's manager", () => other],
    ["a tenant of the bill", () => tenantUser],
  ])("refuses %s", async (_label, who) => {
    caller = who();
    const out = await reconcile(A_HELD, record({ typed: "Akello Grace" }));
    expect(out.status).toBe(403);
    expect((await state(BILL_A, A_HELD)).attempt?.status).toBe("needs_reconciliation");
  });

  it("refuses a completed adjustment without the tenant's name, or with another", async () => {
    caller = manager;
    expect(await reconcile(A_HELD, record())).toEqual({
      status: 428,
      body: { error: "Recording a completed adjustment needs the tenant's name typed: use Record completed adjustment.", reason: "payments_reconcile_name_required" },
    });
    expect(await reconcile(A_HELD, record({ typed: "Akello" }))).toEqual({
      status: 428,
      body: { error: "The name typed does not match this bill's tenant.", reason: "payments_reconcile_name_mismatch" },
    });
  });

  it("refuses, with fixed copy, an amount that does not settle the bill, and accepting receipts that fall short", async () => {
    caller = manager;
    expect(await reconcile(A_HELD, record({ amount: 1000, typed: "Akello Grace" }))).toEqual({
      status: 409,
      body: { error: "The amount must bring the received total to exactly the current bill, with a reference and notes.", reason: "payments_adjustment_inexact" },
    });
    expect(await reconcile(A_HELD, { action: "accept_exact" })).toEqual({
      status: 409,
      body: { error: "The verified receipts do not come to exactly the current bill: record a completed adjustment instead.", reason: "payments_not_exact" },
    });
    expect((await state(BILL_A, A_HELD)).bill).toBe("unpaid");
  });

  it("records a completed adjustment with the tenant's name, however it is spaced, as the manager", async () => {
    caller = manager;
    const out = await reconcile(A_HELD, record({ typed: " Akello Grace " }));
    expect(out.status).toBe(200);
    const after = await state(BILL_A, A_HELD);
    expect(after.bill).toBe("paid");
    expect(after.attempt).toEqual({ status: "resolved", resolved_by: manager.userId });
    expect(after.events).toEqual([
      expect.objectContaining({
        source: "manual",
        actor_kind: "human",
        actor_user_id: manager.userId,
        to_status: "paid",
        raw_payload: expect.objectContaining({ action: "record_external", external_amount: 2000, reference: "MTN-CASH-1", attempt_id: A_HELD }),
      }),
    ]);
  });

  // Relies on the case before it, which resolved A_HELD.
  it("refuses an attempt that no longer needs reconciliation", async () => {
    caller = manager;
    expect(await reconcile(A_HELD, record({ typed: "Akello Grace" }))).toEqual({
      status: 409,
      body: { error: "This attempt does not need reconciliation.", reason: "payments_nothing_to_reconcile" },
    });
  });

  it("accepts receipts that come to the bill exactly, without a name", async () => {
    caller = manager;
    expect((await reconcile(B_HELD, { action: "accept_exact" })).status).toBe(200);
    const after = await state(BILL_B, B_HELD);
    expect(after.bill).toBe("paid");
    expect(after.attempt?.status).toBe("resolved");
    expect(after.events).toEqual([expect.objectContaining({ actor_user_id: manager.userId, raw_payload: expect.objectContaining({ action: "accept_exact", external_amount: 0 }) })]);
  });

  it("refuses, with fixed copy, a bill with a checkout whose outcome is unknown, whichever the resolution", async () => {
    caller = manager;
    const refusal = { status: 409, body: { error: RECONCILE_COPY.unknownOutcome, reason: "payments_unknown_outcome" } };
    expect(await reconcile(C_HELD, { action: "accept_exact" })).toEqual(refusal);
    expect(await reconcile(C_HELD, record({ amount: 0, typed: "Kato Joseph" }))).toEqual(refusal);
    const after = await state(BILL_C, C_HELD);
    expect(after.bill).toBe("unpaid");
    expect(after.attempt?.status).toBe("needs_reconciliation");
    expect(after.events).toEqual([]);
  });

  it("refuses, with fixed copy, a bill with receipts in another currency", async () => {
    caller = manager;
    expect(await reconcile(D_HELD, { action: "accept_exact" })).toEqual({
      status: 409,
      body: { error: RECONCILE_COPY.mixed, reason: "payments_mixed_currencies" },
    });
    const after = await state(BILL_D, D_HELD);
    expect(after.bill).toBe("unpaid");
    expect(after.attempt?.status).toBe("needs_reconciliation");
    expect(after.events).toEqual([]);
  });

  it("accepts receipts that come to the bill exactly while Payments is off", async () => {
    caller = manager;
    await whilePaymentsOff(async () => {
      expect((await reconcile(E_HELD, { action: "accept_exact" })).status).toBe(200);
      const after = await state(BILL_E, E_HELD);
      expect(after.bill).toBe("paid");
      expect(after.attempt).toEqual({ status: "resolved", resolved_by: manager.userId });
    });
  });

  it("records a completed adjustment with the tenant's name while Payments is off", async () => {
    caller = manager;
    await whilePaymentsOff(async () => {
      expect((await reconcile(F_HELD, record({ amount: 1500, typed: "Atim Sarah" }))).status).toBe(200);
      const after = await state(BILL_F, F_HELD);
      expect(after.bill).toBe("paid");
      expect(after.attempt).toEqual({ status: "resolved", resolved_by: manager.userId });
      expect(after.events).toEqual([
        expect.objectContaining({
          actor_user_id: manager.userId,
          raw_payload: expect.objectContaining({ action: "record_external", external_amount: 1500, attempt_id: F_HELD }),
        }),
      ]);
    });
  });

  it("called nothing but the local Supabase", () => {
    const urls = fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => !u.startsWith(LOCAL_SUPABASE_URL))).toEqual([]);
  });
});
