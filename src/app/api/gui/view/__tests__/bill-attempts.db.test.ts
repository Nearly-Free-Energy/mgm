/**
 * GET /api/gui/view serves a period's payments, `payments.bill-attempts`:
 * the host resolves the microgrid and the period through the person's own
 * client, the loader reads the period and its bills through that client,
 * and one bill's attempts, receipts and balance through the Payments
 * capability's listHistory, composed with the same client. The period
 * review lists the view as its Payments tab. POST /api/gui/prepare builds
 * each reconciliation's confirmation step. No checkout URL, tracking id or
 * failure message reaches any output; another organization's manager and a
 * tenant get nothing; while Payments is off the tab is gone and the view
 * loads read-only with the gate's notice. Refresh status is never pressed:
 * it would ask the provider. Nothing here calls out: every request goes to
 * the local Supabase.
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
    if (!caller) throw new Error("[bill-attempts.db] no caller");
    return caller.client;
  },
}));

import { POST as prepareRoute } from "../../prepare/route";
import { GET } from "../route";

const ORG = "e8600000-0000-4000-8000-000000000001";
const OTHER_ORG = "e8600000-0000-4000-8000-000000000002";
const COMMUNITY = "e8600000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e8600000-0000-4000-8001-000000000002";
const MICROGRID = "e8600000-0000-4000-8002-000000000001";
const OTHER_MICROGRID = "e8600000-0000-4000-8002-000000000002";
const SCHEDULE = "e8600000-0000-4000-8006-000000000001";
const OTHER_SCHEDULE = "e8600000-0000-4000-8006-000000000002";
const MERCHANT = "e8600000-0000-4000-8007-000000000001";
/** October, with bills A and B. */
const PERIOD = "e8600000-0000-4000-8003-000000000001";
/** September, on the same microgrid, with bill S. */
const SEPTEMBER = "e8600000-0000-4000-8003-000000000002";
/** Another organization's period, with bill X. */
const OTHER_PERIOD = "e8600000-0000-4000-8003-000000000003";
const tenant = (n: number) => `e8600000-0000-4000-8004-00000000000${n}`;
const BILL_A = "e8600000-0000-4000-8005-000000000001";
const BILL_B = "e8600000-0000-4000-8005-000000000002";
const BILL_S = "e8600000-0000-4000-8005-000000000003";
const BILL_X = "e8600000-0000-4000-8005-000000000004";
/** Bill A: held for reconciliation, its receipt 3,000 short of the bill's 5,000. */
const A_HELD = "e8600000-0000-4000-8008-000000000001";
/** Bill A: a checkout that never reached the provider, whose URL and message are canaries. */
const A_FAILED = "e8600000-0000-4000-8008-000000000002";
/** Bill B: held for reconciliation, its receipt exactly the bill's 3,000. */
const B_HELD = "e8600000-0000-4000-8008-000000000003";
const CHECKOUT_CANARY = "https://canary.invalid/checkout/bill-attempts-db";
const MESSAGE_CANARY = "Pesapal returned 500: canary-raw-provider-body";
const TRACKING_CANARY = "canary-tracking-bill-attempts";
const EMAIL = "gui-attempts-manager@test.local";
const OTHER_EMAIL = "gui-attempts-other@test.local";
const TENANT_EMAIL = "gui-attempts-tenant@test.local";

let manager: TestUser;
let other: TestUser;
let tenantUser: TestUser;
let fetchSpy: { mock: { calls: Parameters<typeof fetch>[] }; mockRestore(): void };

const href = (o: { periodId?: string; microgridId?: string; bill?: string } = {}) =>
  `/microgrids/${o.microgridId ?? MICROGRID}/billing/${o.periodId ?? PERIOD}/payments${o.bill === undefined ? "" : `?bill=${o.bill}`}`;
const view = (path: string) => GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(path)}`, { headers: { "accept-language": "en-GB" } }));
const prepare = (action: string, id: string) =>
  prepareRoute(
    new NextRequest("http://localhost/api/gui/prepare", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "en-GB" },
      body: JSON.stringify({ action, params: { id } }),
    }),
  );

type Cell = { t: string; text: string; v?: string };
type Ref = { action: string; enabled: boolean; reason?: string; tone?: string; prefill?: unknown };
type Row = { id: string; href?: string; entity?: { kind: string; id: string }; cells: Record<string, Cell>; actions: Ref[] };
type Model = {
  title: string;
  subtitle?: string;
  notice?: { text: string };
  entity?: unknown;
  links: { id: string; href: string }[];
  attached: { view: string; title: string; href: string; hint: string }[];
  actions: Ref[];
  body: { rows: Row[]; empty: { title: string } };
};
const loaded = async (path: string): Promise<Model> => {
  const res = await view(path);
  expect(res.status).toBe(200);
  return (await res.json()) as Model;
};

async function setPlugin(plugin: "billing" | "payments", enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_plugins").upsert({ org_id: ORG, plugin_name: plugin, version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[bill-attempts.db] mgm_plugins: ${error.message}`);
}

// payment_merchant_versions references organizations without ON DELETE
// CASCADE, so its rows go first, as in send-queue.db.test.ts; if that
// foreign key gains a cascade, this delete becomes a no-op. Payment attempts
// are kept with their bill (20261103160000), so cleanupTestData purges the
// organization as the database owner.
async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  const { error } = await svc.from("payment_merchant_versions").delete().in("org_id", [ORG, OTHER_ORG]);
  if (error) throw new Error(`[bill-attempts.db] payment_merchant_versions: ${error.message}`);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, OTHER_EMAIL, TENANT_EMAIL] });
}

const bill = (id: string, periodId: string, tenantId: string, total: number) => ({
  id,
  billing_period_id: periodId,
  tenant_id: tenantId,
  start_kwh: 0,
  end_kwh: 10,
  usage_kwh: 10,
  total_amount: total,
  reading_source: "manual",
});
/** An attempt with every key spelled out: a multi-row insert sends the union of the rows' keys. */
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
const receipt = (attemptId: string, amount: number, tracking: string) => ({
  org_id: ORG,
  attempt_id: attemptId,
  amount,
  currency: "UGX",
  provider: "pesapal",
  provider_status: "completed",
  provider_tracking_id: tracking,
  confirmation_code: `CODE-${amount}`,
  raw_payload: { canary: "canary-receipt-payload" },
});

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // Payments builds its repository with a service-role client
  // (createSupabasePaymentsRepository in src/lib/payments/compose.ts), made
  // from SUPABASE_SERVICE_ROLE_KEY and the server Supabase URL, where
  // SUPABASE_INTERNAL_URL wins over MGM_PUBLIC_SUPABASE_URL (src/lib/supabase/service.ts);
  // listHistory itself reads through the person's client. If either file
  // reads other names, revisit.
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  // Before any client exists, so every request a client makes passes through it.
  fetchSpy = vi.spyOn(globalThis, "fetch");
  await cleanup();
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "GUI Attempts Org" }, { id: OTHER_ORG, name: "GUI Attempts Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "GUI Attempts Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI Attempts Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "Attempts site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: OTHER_MICROGRID, community_id: OTHER_COMMUNITY, name: "Other attempts site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    [
      "rate_schedules",
      [
        { id: SCHEDULE, microgrid_id: MICROGRID, tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }], service_charge: 0, tax_rate: 0 },
        { id: OTHER_SCHEDULE, microgrid_id: OTHER_MICROGRID, tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 500 }], service_charge: 0, tax_rate: 0 },
      ],
    ],
    [
      "tenants",
      [
        { id: tenant(1), microgrid_id: MICROGRID, display_name: "Akello Grace", primary_phone: "+256700000801" },
        { id: tenant(2), microgrid_id: MICROGRID, display_name: "Byaruhanga Peter", primary_phone: "+256700000802" },
        { id: tenant(3), microgrid_id: OTHER_MICROGRID, display_name: "Other Tenant", primary_phone: "+256700000803" },
      ],
    ],
    [
      "billing_periods",
      [
        { id: PERIOD, microgrid_id: MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", status: "draft", timezone: "Africa/Kampala", rate_schedule_id: SCHEDULE },
        { id: SEPTEMBER, microgrid_id: MICROGRID, start_date: "2026-09-01", end_date: "2026-09-30", status: "draft", timezone: "Africa/Kampala", rate_schedule_id: SCHEDULE },
        { id: OTHER_PERIOD, microgrid_id: OTHER_MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", status: "draft", timezone: "Africa/Kampala", rate_schedule_id: OTHER_SCHEDULE },
      ],
    ],
    [
      "billing_line_items",
      [bill(BILL_A, PERIOD, tenant(1), 5000), bill(BILL_B, PERIOD, tenant(2), 3000), bill(BILL_S, SEPTEMBER, tenant(1), 1000), bill(BILL_X, OTHER_PERIOD, tenant(3), 2000)],
    ],
    ["payment_merchant_accounts", { id: MERCHANT, org_id: ORG, provider: "pesapal", is_default: true, sandbox: true, last_test_status: "success", ipn_id: "ipn-test" }],
    [
      "payment_attempts",
      [
        attempt(A_HELD, BILL_A, { status: "needs_reconciliation", provider_tracking_id: TRACKING_CANARY, failure_code: "balance_mismatch", failure_message: "Receipt differs from current bill or duplicates an existing settlement", created_at: "2026-10-05T08:00:00+00:00" }),
        attempt(A_FAILED, BILL_A, { status: "failed", failure_code: "checkout_not_submitted", failure_message: MESSAGE_CANARY, checkout_url: CHECKOUT_CANARY, created_at: "2026-10-04T08:00:00+00:00" }),
        attempt(B_HELD, BILL_B, { amount: 3000, bill_revision_total: 3000, status: "needs_reconciliation", provider_tracking_id: "trk-b", failure_code: "bill_revised", created_at: "2026-10-06T08:00:00+00:00" }),
      ],
    ],
    ["payment_receipts", [receipt(A_HELD, 3000, TRACKING_CANARY), receipt(B_HELD, 3000, "trk-b")]],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[bill-attempts.db] ${table}: ${error.message}`);
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

const NO_SECRETS = [CHECKOUT_CANARY, MESSAGE_CANARY, "canary-raw-provider-body", TRACKING_CANARY, "trk-b", "canary-receipt-payload", MERCHANT];

describe.skipIf(shouldSkip())("GET /api/gui/view: a period's payments", () => {
  it("lists the period's bills, each linking to its own attempts", async () => {
    caller = manager;
    const model = await loaded(href());
    expect(model).toMatchObject({ title: "Payments", subtitle: "1 Oct 2026 – 31 Oct 2026", actions: [] });
    expect(model).not.toHaveProperty("entity");
    expect(model.body.rows.map((r) => [r.cells.tenant.text, r.href])).toEqual([
      ["Akello Grace", href({ bill: BILL_A })],
      ["Byaruhanga Peter", href({ bill: BILL_B })],
    ]);
    expect(model.body.rows.every((r) => r.actions.length === 0)).toBe(true);
  });

  it("shows one bill's attempts, receipts and balance, with fixed notes and no provider secrets", async () => {
    caller = manager;
    const res = await view(href({ bill: BILL_A }));
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of NO_SECRETS) expect(text, secret).not.toContain(secret);
    const model = JSON.parse(text) as Model;
    expect(model.title).toBe("Payments: Akello Grace");
    expect(model.subtitle).toMatch(/^1 Oct 2026 – 31 Oct 2026 · Bill UGX\s?5,000 · Received UGX\s?3,000 · Difference -UGX\s?2,000$/);
    expect(model.links).toEqual([expect.objectContaining({ id: "payments.all-bills", href: href() })]);
    // Oldest first.
    expect(model.body.rows.map((r) => [r.id, r.cells.status.v, r.cells.note.text])).toEqual([
      [A_FAILED, "failed", "The checkout never reached the provider."],
      [A_HELD, "needs_reconciliation", "The receipt differs from the current bill or repeats a settlement."],
    ]);
    expect(model.body.rows[1].cells.receipts.text).toMatch(/^Completed UGX\s?3,000 · code CODE-3000$/);
    // Refresh only where there is a tracking id; Accept unavailable while the receipts fall short.
    expect(model.body.rows[0].actions).toEqual([]);
    expect(model.body.rows[1].actions.map((a) => [a.action, a.enabled, a.reason])).toEqual([
      ["payments.refresh-attempt", true, undefined],
      ["payments.record-adjustment", true, undefined],
      ["payments.accept-receipts", false, "The verified receipts do not come to exactly the current bill: record a completed adjustment instead."],
    ]);
    expect(model.body.rows[1].actions[1]).toMatchObject({ tone: "danger", prefill: { action: "record_external" } });
  });

  it("offers accepting receipts that come to the bill exactly", async () => {
    caller = manager;
    const model = await loaded(href({ bill: BILL_B }));
    expect(model.body.rows[0].actions.find((a) => a.action === "payments.accept-receipts")).toMatchObject({ enabled: true, prefill: { action: "accept_exact" } });
  });

  it("is listed as the period review's Payments tab", async () => {
    caller = manager;
    const review = await loaded(`/microgrids/${MICROGRID}/billing/${PERIOD}`);
    expect(review.attached).toContainEqual({ view: "payments.bill-attempts", title: "Payments", href: href(), hint: "tab" });
  });

  it.each([
    ["a bill of another period", BILL_S],
    ["another organization's bill", BILL_X],
    ["an id that is not a bill", "not-a-uuid"],
  ])("finds nothing for %s", async (_label, billId) => {
    caller = manager;
    const res = await view(href({ bill: billId }));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Other Tenant");
  });

  it.each([
    ["another organization's manager", () => other],
    ["a tenant of the bill", () => tenantUser],
  ])("gives %s nothing", async (_label, who) => {
    caller = who();
    const res = await view(href({ bill: BILL_A }));
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("Akello");
    expect(text).not.toContain("MGM-");
  });

  describe("POST /api/gui/prepare", () => {
    it("asks for the tenant's name to record a completed adjustment, and names the amount that settles the bill", async () => {
      caller = manager;
      const res = await prepare("payments.record-adjustment", A_HELD);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const secret of NO_SECRETS) expect(text, secret).not.toContain(secret);
      const prepared = JSON.parse(text) as { confirm: string; ceremony: { typed: string; warnings: string[] } };
      expect(prepared.confirm).toBe("typed");
      expect(prepared.ceremony.typed).toBe("Akello Grace");
      expect(prepared.ceremony.warnings[0]).toMatch(/^Enter UGX\s?2,000 as the external amount/);
    });

    it("refuses with fixed copy to accept receipts that fall short, and to reconcile an attempt that needs none", async () => {
      caller = manager;
      const short = await prepare("payments.accept-receipts", A_HELD);
      expect(short.status).toBe(409);
      expect(await short.json()).toMatchObject({ message: "The verified receipts do not come to exactly the current bill: record a completed adjustment instead." });
      const failed = await prepare("payments.record-adjustment", A_FAILED);
      expect(failed.status).toBe(409);
      expect(await failed.json()).toMatchObject({ message: "This attempt does not need reconciliation." });
    });

    it("gives another organization's manager nothing", async () => {
      caller = other;
      const res = await prepare("payments.record-adjustment", A_HELD);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("Akello");
    });
  });

  it("while Payments is off, drops the tab, and loads read-only with the gate's notice", async () => {
    caller = manager;
    await setPlugin("payments", false);
    try {
      const review = await loaded(`/microgrids/${MICROGRID}/billing/${PERIOD}`);
      expect(review.attached.map((a) => a.view)).not.toContain("payments.bill-attempts");
      const model = await loaded(href({ bill: BILL_A }));
      expect(model.notice?.text).toMatch(/^Payments are disabled for this organization/);
      expect(model.body.rows).toHaveLength(2);
      const actions = model.body.rows.flatMap((r) => r.actions);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.every((a) => !a.enabled && a.reason === model.notice?.text)).toBe(true);
      expect((await prepare("payments.record-adjustment", A_HELD)).status).toBe(409);
    } finally {
      await setPlugin("payments", true);
    }
  });

  it("called nothing but the local Supabase", () => {
    const urls = fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => !u.startsWith(LOCAL_SUPABASE_URL))).toEqual([]);
  });
});
