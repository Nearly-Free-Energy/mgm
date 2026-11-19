/**
 * GET /api/gui/view serves a community's payment setup,
 * `payments.payment-setup`, a section of a period's send queue: the host
 * resolves the microgrid and the period through the person's own client,
 * and the loader reads them through that client and the community's
 * payment readiness through composePayments with the same client. A super
 * admin gets the link to the community's Payment page, an organization
 * manager is told to ask one; nothing of the merchant account reaches the
 * model. Another organization's manager and a tenant get nothing; while
 * Payments is off the section still loads and is still listed on the send
 * queue, with the gate's notice. Nothing here calls out: every request goes
 * to the local Supabase.
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
    if (!caller) throw new Error("[payment-setup.db] no caller");
    return caller.client;
  },
}));

import { GET } from "../route";

const ORG = "e8800000-0000-4000-8000-000000000001";
const OTHER_ORG = "e8800000-0000-4000-8000-000000000002";
const COMMUNITY = "e8800000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e8800000-0000-4000-8001-000000000002";
const MICROGRID = "e8800000-0000-4000-8002-000000000001";
const SECOND_MICROGRID = "e8800000-0000-4000-8002-000000000002";
const OTHER_MICROGRID = "e8800000-0000-4000-8002-000000000003";
const PERIOD = "e8800000-0000-4000-8003-000000000001";
const SCHEDULE = "e8800000-0000-4000-8006-000000000001";
const TENANT = "e8800000-0000-4000-8004-000000000001";
const MERCHANT = "e8800000-0000-4000-8007-000000000001";
/** Stored on the merchant account; none may reach a model. */
const CONSUMER_KEY = "setup-consumer-key-canary";
const TEST_MESSAGE = "setup-last-test-message-canary";
const EMAIL = "gui-setup-manager@test.local";
const ADMIN_EMAIL = "gui-setup-admin@test.local";
const OTHER_EMAIL = "gui-setup-other@test.local";
const TENANT_EMAIL = "gui-setup-tenant@test.local";

let manager: TestUser;
let admin: TestUser;
let other: TestUser;
let tenantUser: TestUser;
let fetchSpy: { mock: { calls: Parameters<typeof fetch>[] }; mockRestore(): void };

const href = (microgridId = MICROGRID, periodId = PERIOD) => `/microgrids/${microgridId}/billing/${periodId}/payment-setup`;
const view = (path: string) => GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(path)}`, { headers: { "accept-language": "en-GB" } }));

type Field = { key: string; value: { t: string; v?: string; text: string } };
type Model = {
  view: string;
  kind: string;
  org: string;
  title: string;
  notice?: { tone: string; text: string };
  actions: unknown[];
  links: { id: string; label: string; href: string }[];
  attached: { view: string; title: string; href: string; hint: string }[];
  body: { sections: { fields: Field[] }[] };
};
const loaded = async (path: string): Promise<Model> => {
  const res = await view(path);
  expect(res.status).toBe(200);
  return (await res.json()) as Model;
};
const fieldsOf = (m: Model) => Object.fromEntries(m.body.sections.flatMap((s) => s.fields).map((f) => [f.key, f.value]));

async function setPlugin(plugin: "payments", enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_plugins").upsert({ org_id: ORG, plugin_name: plugin, version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[payment-setup.db] mgm_plugins: ${error.message}`);
}

async function setMerchant(patch: Record<string, unknown>) {
  const svc = await serviceClient();
  const { error } = await svc.from("payment_merchant_accounts").update(patch).eq("id", MERCHANT);
  if (error) throw new Error(`[payment-setup.db] merchant: ${error.message}`);
}

// payment_merchant_versions references organizations without ON DELETE
// CASCADE, so its rows go first, as in send-queue.db.test.ts; if that
// foreign key gains a cascade, this delete becomes a no-op.
async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  const { error } = await svc.from("payment_merchant_versions").delete().in("org_id", [ORG, OTHER_ORG]);
  if (error) throw new Error(`[payment-setup.db] payment_merchant_versions: ${error.message}`);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, ADMIN_EMAIL, OTHER_EMAIL, TENANT_EMAIL] });
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // Payments builds its repository with a service-role client
  // (createSupabasePaymentsRepository in src/lib/payments/compose.ts), made
  // from SUPABASE_SERVICE_ROLE_KEY and the server Supabase URL, where
  // SUPABASE_INTERNAL_URL wins over MGM_PUBLIC_SUPABASE_URL (src/lib/supabase/service.ts);
  // readiness itself reads through the person's client. If either file
  // reads other names, revisit.
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  // Before any client exists, so every request a client makes passes through it.
  fetchSpy = vi.spyOn(globalThis, "fetch");
  await cleanup();
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "GUI Setup Org" }, { id: OTHER_ORG, name: "GUI Setup Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "GUI Setup Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI Setup Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "Setup site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: SECOND_MICROGRID, community_id: COMMUNITY, name: "Second setup site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: OTHER_MICROGRID, community_id: OTHER_COMMUNITY, name: "Other setup site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    [
      "rate_schedules",
      {
        id: SCHEDULE,
        microgrid_id: MICROGRID,
        tiers: [{ label: "Lifeline", min_kwh: 1, max_kwh: null, rate_per_kwh: 250 }],
        service_charge: 0,
        tax_rate: 0,
      },
    ],
    ["tenants", { id: TENANT, microgrid_id: MICROGRID, display_name: "Setup unit 1", primary_phone: "+256700000901" }],
    [
      "billing_periods",
      {
        id: PERIOD,
        microgrid_id: MICROGRID,
        start_date: "2026-10-01",
        end_date: "2026-10-31",
        timezone: "Africa/Kampala",
        status: "draft",
        rate_schedule_id: SCHEDULE,
      },
    ],
    // The organization's default Pesapal account, tested and registered, so readiness is "ready".
    [
      "payment_merchant_accounts",
      {
        id: MERCHANT,
        org_id: ORG,
        provider: "pesapal",
        is_default: true,
        sandbox: false,
        consumer_key: CONSUMER_KEY,
        last_test_status: "success",
        last_test_message: TEST_MESSAGE,
        ipn_id: "ipn-test",
      },
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[payment-setup.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  admin = await createTestUser({ email: ADMIN_EMAIL, role: "super_admin" });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: TENANT });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
  fetchSpy?.mockRestore();
  vi.unstubAllEnvs();
}, 60_000);

describe.skipIf(shouldSkip())("GET /api/gui/view: a community's payment setup", () => {
  it("shows a live account to an organization manager, with no link and no actions", async () => {
    caller = manager;
    await setPlugin("payments", true);
    const model = await loaded(href());
    expect(model).toMatchObject({ view: "payments.payment-setup", kind: "record", org: ORG, title: "Payment setup" });
    expect(model).not.toHaveProperty("notice");
    expect(fieldsOf(model)).toEqual({
      status: { t: "status", v: "ready", tone: "success", text: "Live" },
      next: { t: "text", text: "Nothing to do: payment links use the community's live account." },
    });
    expect(model.links).toEqual([]);
    expect(model.actions).toEqual([]);
    // Nothing of the merchant account reaches the model.
    const text = JSON.stringify(model);
    for (const s of [CONSUMER_KEY, TEST_MESSAGE, MERCHANT, "ipn-test"]) expect(text).not.toContain(s);
  });

  it("links a super admin to the community's Payment page when no provider is configured", async () => {
    caller = admin;
    await setMerchant({ is_default: false });
    try {
      const model = await loaded(href());
      expect(model.org).toBe(ORG);
      expect(fieldsOf(model)).toEqual({
        status: { t: "status", v: "unconfigured", tone: "warning", text: "Not set up" },
        next: { t: "text", text: "No payment provider is configured for this community. Connect one on the community's Payment page." },
      });
      expect(model.links).toEqual([{ id: "payments.community-payment", label: "Community Payment page", href: `/communities/${COMMUNITY}/payment` }]);
    } finally {
      await setMerchant({ is_default: true });
    }
  });

  it("tells an organization manager to ask a super admin when no provider is configured", async () => {
    caller = manager;
    await setMerchant({ is_default: false });
    try {
      const model = await loaded(href());
      expect(fieldsOf(model).next).toEqual({
        t: "text",
        text: "No payment provider is configured for this community. Ask a super admin to configure Payment for this community.",
      });
      expect(model.links).toEqual([]);
    } finally {
      await setMerchant({ is_default: true });
    }
  });

  it("says an account that failed its last connection test cannot take payments, without its message", async () => {
    caller = manager;
    await setMerchant({ last_test_status: "auth_failed" });
    try {
      const model = await loaded(href());
      expect(fieldsOf(model).status).toMatchObject({ v: "connection_error", text: "Not connected" });
      expect(JSON.stringify(model)).not.toContain(TEST_MESSAGE);
    } finally {
      await setMerchant({ last_test_status: "success" });
    }
  });

  it("still loads while Payments is off, with the gate's notice, and stays listed on the send queue", async () => {
    caller = manager;
    await setPlugin("payments", false);
    try {
      const model = await loaded(href());
      expect(model.notice).toMatchObject({ tone: "warning", text: expect.stringContaining("Payments are disabled") });
      expect(fieldsOf(model)).toEqual({
        status: { t: "status", v: "disabled", tone: "neutral", text: "Off" },
        next: { t: "text", text: "Online payments are turned off for this organization. Turn on Payments and Pesapal in Settings → Plugins." },
      });
      const queue = await loaded(`/microgrids/${MICROGRID}/billing/${PERIOD}/send`);
      expect(queue.attached).toContainEqual({ view: "payments.payment-setup", title: "Payment setup", href: href(), hint: "section" });
    } finally {
      await setPlugin("payments", true);
    }
  });

  it("is listed on the send queue as a section", async () => {
    caller = manager;
    const queue = await loaded(`/microgrids/${MICROGRID}/billing/${PERIOD}/send`);
    expect(queue.attached).toContainEqual({ view: "payments.payment-setup", title: "Payment setup", href: href(), hint: "section" });
  });

  it("finds no period under another microgrid", async () => {
    caller = manager;
    expect((await view(href(SECOND_MICROGRID))).status).toBe(404);
  });

  it("gives another organization's manager nothing", async () => {
    caller = other;
    const res = await view(href());
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(COMMUNITY);
    expect(text).not.toContain("Setup site");
  });

  it("gives a tenant of the microgrid nothing", async () => {
    caller = tenantUser;
    const res = await view(href());
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(COMMUNITY);
    expect(text).not.toContain("Setup site");
  });

  it("called nothing but the local Supabase", () => {
    const urls = fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => !u.startsWith(LOCAL_SUPABASE_URL))).toEqual([]);
  });
});
