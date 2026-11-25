/**
 * GET /api/gui/signals collects the real contributed watchers through the
 * host against the local database: billing's overdue periods (critical a
 * week after their end) and microgrids with metered tenants and no period
 * for last month, metering's failed connection checks, and payments held
 * for reconciliation, recently failed, or checkouts that never reached
 * Pesapal, all read with the caller's own session. Another organization's
 * manager, and a super admin acting in another organization, get none of
 * this organization's signals; a person whose rows are all tenant rows gets
 * a 403 and no watcher runs. While billing is off its watchers are skipped;
 * while Payments is off reconciliation is still reported and failures and
 * checkouts never submitted are not. A period ending today in its own zone
 * is not yet due. No tenant's name reaches the answer. Nothing here calls
 * out: every request goes to the local Supabase.
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
import { addDaysToDateKey, dayKeyInZone } from "@/lib/timezone/day-key";

let caller: TestUser | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!caller) throw new Error("[signals.db] no caller");
    return caller.client;
  },
}));

import { GET } from "../route";

const ORG = "e8700000-0000-4000-8000-000000000001";
const OTHER_ORG = "e8700000-0000-4000-8000-000000000002";
const COMMUNITY = "e8700000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e8700000-0000-4000-8001-000000000002";
const MICROGRID = "e8700000-0000-4000-8002-000000000001";
const OTHER_MICROGRID = "e8700000-0000-4000-8002-000000000002";
/** A microgrid of this organization with a metered tenant and no billing period at all. */
const UNBILLED = "e8700000-0000-4000-8002-000000000003";
const EDGE = "e8700000-0000-4000-8009-000000000001";
const DEVICE = "e8700000-0000-4000-800a-000000000001";
const SCHEDULE = "e8700000-0000-4000-8006-000000000001";
const MERCHANT = "e8700000-0000-4000-8007-000000000001";
/** October: ended, two bills, one payment held and one failed. */
const OCTOBER = "e8700000-0000-4000-8003-000000000001";
/** September: ended, no bills. */
const SEPTEMBER = "e8700000-0000-4000-8003-000000000002";
/** Ends today in Kampala: not yet due. */
const RUNNING = "e8700000-0000-4000-8003-000000000003";
const tenant = (n: number) => `e8700000-0000-4000-8004-00000000000${n}`;
const BILL_HELD = "e8700000-0000-4000-8005-000000000001";
const BILL_FAILED = "e8700000-0000-4000-8005-000000000002";
const HELD = "e8700000-0000-4000-8008-000000000001";
const FAILED = "e8700000-0000-4000-8008-000000000002";
/** Three checkouts that never reached Pesapal, in this organization's community. */
const UNSUBMITTED = [3, 4, 5].map((n) => `e8700000-0000-4000-8008-00000000000${n}`);
const TENANT_NAME = "Nakato Signals-Canary";
const EMAIL = "gui-signals-manager@test.local";
const OTHER_EMAIL = "gui-signals-other@test.local";
const ADMIN_EMAIL = "gui-signals-admin@test.local";
const TENANT_EMAIL = "gui-signals-tenant@test.local";

/**
 * Whether last month's missing period is reported for UNBILLED today: from
 * the 2nd of the month in its zone (billing.period-missing). Read when the
 * file loads; a run that crosses midnight of the 2nd in Kampala may see it
 * change.
 */
const REPORTS_MISSING = Number(dayKeyInZone(new Date(), "Africa/Kampala").slice(8, 10)) >= 2;

/** Every signal id this organization's data gives rise to, by watcher. */
const IDS: Record<string, string[]> = {
  "billing.period-due": [`billing.period-due:${SEPTEMBER}`, `billing.period-due:${OCTOBER}`],
  "billing.period-missing": REPORTS_MISSING ? [`billing.period-missing:${UNBILLED}`] : [],
  "metering.connection": [`metering.connection:${MICROGRID}`],
  "payments.reconcile": [`payments.reconcile:${OCTOBER}`],
  "payments.failed": [`payments.failed:${OCTOBER}`],
  "payments.not-submitted": [`payments.not-submitted:${COMMUNITY}`],
};
const ALL_IDS: string[] = Object.values(IDS).flat();
const WATCHERS = Object.keys(IDS).sort();

let manager: TestUser;
let other: TestUser;
let admin: TestUser;
let tenantUser: TestUser;
let fetchSpy: { mock: { calls: Parameters<typeof fetch>[] }; mockRestore(): void };

type Signal = { id: string; source: string; severity: string; kind: string; title: string; href: string; entity?: { id: string } };
type Answer = { org: string; count: number; attention?: number; top: Signal[]; checked: string[]; unchecked: string[] };

const signals = (org?: string) =>
  GET(new NextRequest(`http://localhost/api/gui/signals${org ? `?org=${org}` : ""}`, { headers: { "accept-language": "en-GB" } }));
async function answer(org?: string): Promise<{ body: Answer; text: string }> {
  const res = await signals(org);
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return { body: JSON.parse(text) as Answer, text };
}

async function setPlugin(plugin: "billing" | "payments", enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_plugins").upsert({ org_id: ORG, plugin_name: plugin, version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[signals.db] mgm_plugins: ${error.message}`);
}

// payment_merchant_versions references organizations without ON DELETE
// CASCADE, so its rows go first, as in bill-attempts.db.test.ts; payment
// attempts are kept with their bill, so cleanupTestData purges the
// organization as the database owner.
async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  const { error } = await svc.from("payment_merchant_versions").delete().in("org_id", [ORG, OTHER_ORG]);
  if (error) throw new Error(`[signals.db] payment_merchant_versions: ${error.message}`);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, OTHER_EMAIL, ADMIN_EMAIL, TENANT_EMAIL] });
}

const bill = (id: string, periodId: string, tenantId: string) => ({
  id,
  billing_period_id: periodId,
  tenant_id: tenantId,
  start_kwh: 0,
  end_kwh: 10,
  usage_kwh: 10,
  total_amount: 5000,
  reading_source: "manual",
});
const attempt = (id: string, lineItem: string, o: Record<string, unknown>) => ({
  id,
  org_id: ORG,
  line_item_id: lineItem,
  community_id: COMMUNITY,
  merchant_account_id: MERCHANT,
  merchant_account_version: 1,
  amount: 5000,
  currency: "UGX",
  bill_revision_total: 5000,
  merchant_reference: `MGM-${id}`,
  provider_tracking_id: null,
  status: "pending",
  checkout_url: null,
  failure_code: null,
  failure_message: null,
  ...o,
});

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // composePayments builds its repository with a service-role client
  // (src/lib/payments/compose.ts) from SUPABASE_SERVICE_ROLE_KEY and the
  // server Supabase URL (src/lib/supabase/service.ts); listAttention itself
  // reads through the person's client. If either file reads other names,
  // revisit.
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  fetchSpy = vi.spyOn(globalThis, "fetch");
  await cleanup();
  const today = dayKeyInZone(new Date(), "Africa/Kampala");
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "GUI Signals Org" }, { id: OTHER_ORG, name: "GUI Signals Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "GUI Signals Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI Signals Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        {
          id: MICROGRID,
          community_id: COMMUNITY,
          name: "Signals site",
          currency: "UGX",
          timezone: "Africa/Kampala",
          ems_type: "direct_url",
          ems_backend_url: "https://example.invalid/rest",
          ems_last_discover_status: "unreachable",
          // An hour back, so the attempts' updated_at (Postgres now(), a moment later) is the
          // newer of the two undated warnings whichever clock runs ahead: the host orders those
          // by `at`, and a Docker VM's clock can drift behind the test process's.
          ems_last_discover_at: new Date(Date.now() - 60 * 60_000).toISOString(),
          ems_last_discover_error: "canary-vendor-error-text",
        },
        { id: OTHER_MICROGRID, community_id: OTHER_COMMUNITY, name: "Other signals site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: UNBILLED, community_id: COMMUNITY, name: "Unbilled site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    ["edges", { id: EDGE, microgrid_id: UNBILLED, name: "Unbilled edge", openems_edge_id: "signals-unbilled-edge" }],
    ["devices", { id: DEVICE, edge_id: EDGE, name: "Unbilled meter", device_type: "consumption_meter", openems_component_id: "meter9" }],
    ["rate_schedules", { id: SCHEDULE, microgrid_id: MICROGRID, tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }], service_charge: 0, tax_rate: 0 }],
    [
      "tenants",
      [
        { id: tenant(1), microgrid_id: MICROGRID, display_name: TENANT_NAME, primary_phone: "+256700000901" },
        { id: tenant(2), microgrid_id: MICROGRID, display_name: `${TENANT_NAME} Two`, primary_phone: "+256700000902" },
        { id: tenant(3), microgrid_id: UNBILLED, display_name: `${TENANT_NAME} Three`, primary_phone: "+256700000903" },
      ],
    ],
    ["tenant_devices", { tenant_id: tenant(3), device_id: DEVICE, role: "primary_consumption_meter", effective_from: "2026-01-01" }],
    [
      "billing_periods",
      [
        { id: OCTOBER, microgrid_id: MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", status: "draft", timezone: "Africa/Kampala", rate_schedule_id: SCHEDULE },
        { id: SEPTEMBER, microgrid_id: MICROGRID, start_date: "2026-09-01", end_date: "2026-09-30", status: "draft", timezone: "Africa/Kampala", rate_schedule_id: SCHEDULE },
        { id: RUNNING, microgrid_id: MICROGRID, start_date: addDaysToDateKey(today, -2), end_date: today, status: "draft", timezone: "Africa/Kampala", rate_schedule_id: SCHEDULE },
      ],
    ],
    ["billing_line_items", [bill(BILL_HELD, OCTOBER, tenant(1)), bill(BILL_FAILED, OCTOBER, tenant(2))]],
    ["payment_merchant_accounts", { id: MERCHANT, org_id: ORG, provider: "pesapal", is_default: true, sandbox: true, last_test_status: "success", ipn_id: "ipn-test" }],
    [
      "payment_attempts",
      [
        attempt(HELD, BILL_HELD, { status: "needs_reconciliation", provider_tracking_id: "trk-signals", failure_code: "balance_mismatch" }),
        attempt(FAILED, BILL_FAILED, { status: "failed", failure_code: "provider_failed", failure_message: "canary-provider-message" }),
      ],
    ],
    // A separate insert: a multi-row insert sends the union of its rows' keys, so HELD and FAILED
    // would get updated_at null. Two hours back: inside the watcher's 24 hours, and older than
    // FAILED's updated_at (Postgres now()), so of the two undated warnings payments.failed is the
    // newer whichever clock runs ahead.
    [
      "payment_attempts",
      UNSUBMITTED.map((id) =>
        attempt(id, BILL_FAILED, {
          status: "failed",
          failure_code: "checkout_not_submitted",
          failure_message: "canary-not-submitted-message",
          updated_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        }),
      ),
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[signals.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  admin = await createTestUser({ email: ADMIN_EMAIL, role: "super_admin", scopeId: null });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: tenant(1) });
}, 120_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
  fetchSpy?.mockRestore();
  vi.unstubAllEnvs();
}, 120_000);

const ours = (body: Answer) => body.top.map((s) => s.id).filter((id) => ALL_IDS.includes(id)).sort();

describe.skipIf(shouldSkip())("GET /api/gui/signals against the database", () => {
  it("gives the organization's manager every watcher's signals, with fixed copy and no tenant", async () => {
    caller = manager;
    const { body, text } = await answer(ORG);
    expect(body.org).toBe(ORG);
    expect([...body.checked].sort()).toEqual(WATCHERS);
    expect(body.unchecked).toEqual([]);
    expect(ours(body)).toEqual([...ALL_IDS].sort());
    expect(body.count).toBe(ALL_IDS.length);
    // Two critical signals; the rest warn and none is info, so the badge counts them all.
    expect(body.attention).toBe(ALL_IDS.length);
    expect(body.top.map((s) => [s.id, s.severity, s.title, s.href])).toEqual([
      // October ended more than seven days ago in Kampala, so its close is critical; dated, it comes before the undated reconciliation.
      [`billing.period-due:${OCTOBER}`, "critical", "Signals site: October 2026 is not closed", `/microgrids/${MICROGRID}/billing/${OCTOBER}/close`],
      // The held attempt has a tracking id, so money may have reached Pesapal.
      [`payments.reconcile:${OCTOBER}`, "critical", "Signals site: 1 payment in October 2026 needs reconciliation", `/microgrids/${MICROGRID}/billing/${OCTOBER}/payments?bill=${BILL_HELD}`],
      // An alarm comes first among the warnings, ahead of dated ones (order() in signals.ts).
      expect.arrayContaining([`metering.connection:${MICROGRID}`, "warn", "Signals site: OpenEMS could not be reached"]),
      [`billing.period-due:${SEPTEMBER}`, "warn", "Signals site: September 2026 has no bills", `/microgrids/${MICROGRID}/billing/${SEPTEMBER}`],
      ...(REPORTS_MISSING
        ? [[`billing.period-missing:${UNBILLED}`, "warn", expect.stringMatching(/^Unbilled site: no billing period for \w+ \d{4}$/), `/microgrids/${UNBILLED}/billing`]]
        : []),
      expect.arrayContaining([`payments.failed:${OCTOBER}`, "warn", "Signals site: 1 payment failed in October 2026"]),
      [
        `payments.not-submitted:${COMMUNITY}`,
        "warn",
        "GUI Signals Community: 3 checkouts did not reach Pesapal in the last 24 hours",
        `/communities/${COMMUNITY}/payment`,
      ],
    ]);
    // The period ending today in Kampala is not yet due.
    expect(text).not.toContain(RUNNING);
    for (const secret of [TENANT_NAME, "canary-vendor-error-text", "canary-provider-message", "canary-not-submitted-message", "trk-signals", MERCHANT, ...UNSUBMITTED]) {
      expect(text, secret).not.toContain(secret);
    }
    // Every request went to the local Supabase.
    expect(fetchSpy.mock.calls.every(([input]) => String(input instanceof Request ? input.url : input).startsWith(LOCAL_SUPABASE_URL))).toBe(true);
  });

  it("gives another organization's manager, asking for this organization, their own and none of these", async () => {
    caller = other;
    const { body } = await answer(ORG);
    expect(body.org).toBe(OTHER_ORG);
    expect(ours(body)).toEqual([]);
    expect(body.count).toBe(0);
  });

  it("gives a super admin acting in another organization none of these", async () => {
    caller = admin;
    const { body } = await answer(OTHER_ORG);
    expect(body.org).toBe(OTHER_ORG);
    expect(ours(body)).toEqual([]);
    const here = await answer(ORG);
    expect(ours(here.body)).toEqual([...ALL_IDS].sort());
  });

  it("refuses a person whose rows are all tenant rows, with nothing of the organization", async () => {
    caller = tenantUser;
    const res = await signals(ORG);
    expect(res.status).toBe(403);
    const text = await res.text();
    for (const id of [ORG, OCTOBER, MICROGRID]) expect(text).not.toContain(id);
  });

  it("skips billing's watchers while billing is off", async () => {
    caller = manager;
    await setPlugin("billing", false);
    try {
      const { body } = await answer(ORG);
      expect(ours(body)).toEqual(
        [...IDS["metering.connection"], ...IDS["payments.failed"], ...IDS["payments.reconcile"], ...IDS["payments.not-submitted"]].sort(),
      );
      for (const id of ["billing.period-due", "billing.period-missing"]) expect([...body.checked, ...body.unchecked]).not.toContain(id);
    } finally {
      await setPlugin("billing", true);
    }
  });

  it("still reports reconciliation while Payments is off, and no longer failures or checkouts never submitted", async () => {
    caller = manager;
    await setPlugin("payments", false);
    try {
      const { body } = await answer(ORG);
      expect(ours(body)).toEqual(
        [...IDS["billing.period-due"], ...IDS["billing.period-missing"], ...IDS["metering.connection"], ...IDS["payments.reconcile"]].sort(),
      );
      expect(body.checked).toContain("payments.reconcile");
      for (const id of ["payments.failed", "payments.not-submitted"]) expect([...body.checked, ...body.unchecked]).not.toContain(id);
    } finally {
      await setPlugin("payments", true);
    }
  });
});
