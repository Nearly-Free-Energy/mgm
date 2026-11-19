/**
 * GET /api/gui/view serves a period's send queue, `billing.send-queue`: the
 * host resolves the microgrid and the period through the person's own
 * client, and the loader reads the period, the tenants and the bills
 * through that client, and the community's payment readiness through
 * composePayments with the same client. Each bill checkout would accept has
 * its stable link while readiness is ready or sandbox; the others carry a
 * note. Another organization's manager and a tenant get nothing; while
 * billing is off the queue still loads, with the gate's notice. Nothing
 * here calls out: every request goes to the local Supabase.
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
    if (!caller) throw new Error("[send-queue.db] no caller");
    return caller.client;
  },
}));

import { GET } from "../route";

const ORG = "e8100000-0000-4000-8000-000000000001";
const OTHER_ORG = "e8100000-0000-4000-8000-000000000002";
const COMMUNITY = "e8100000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e8100000-0000-4000-8001-000000000002";
const MICROGRID = "e8100000-0000-4000-8002-000000000001";
const SECOND_MICROGRID = "e8100000-0000-4000-8002-000000000002";
const OTHER_MICROGRID = "e8100000-0000-4000-8002-000000000003";
const SCHEDULE = "e8100000-0000-4000-8006-000000000001";
const MERCHANT = "e8100000-0000-4000-8007-000000000001";
/** October: a draft with a bill in every state the queue tells apart. */
const DRAFT = "e8100000-0000-4000-8003-000000000001";
/** September: closed, with an unpaid bill. */
const CLOSED = "e8100000-0000-4000-8003-000000000002";
/** August: no bills. */
const EMPTY = "e8100000-0000-4000-8003-000000000003";
const tenant = (n: number) => `e8100000-0000-4000-8004-00000000000${n}`;
const bill = (n: number) => `e8100000-0000-4000-8005-0000000000${n.toString().padStart(2, "0")}`;
const EMAIL = "gui-send-manager@test.local";
const OTHER_EMAIL = "gui-send-other@test.local";
const TENANT_EMAIL = "gui-send-tenant@test.local";
const TENANT_CONTACT = "send-unit-1@example.org";
const ORIGIN = "https://mgm.example.org";
const link = (id: string) => `${ORIGIN}/api/billing-line-items/${id}/pay`;

let manager: TestUser;
let other: TestUser;
let tenantUser: TestUser;
let fetchSpy: { mock: { calls: Parameters<typeof fetch>[] }; mockRestore(): void };

const href = (periodId: string, microgridId = MICROGRID) => `/microgrids/${microgridId}/billing/${periodId}/send`;
const view = (path: string) => GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(path)}`, { headers: { "accept-language": "en-GB" } }));

type Cell = { t: string; text: string };
type Row = { id: string; cells: Record<string, Cell>; actions: unknown[]; links: { id: string; href: string }[] };
type Model = {
  title: string;
  subtitle?: string;
  notice?: { text: string };
  links: { id: string; href: string }[];
  trail: { label: string }[];
  actions: unknown[];
  body: { rows: Row[]; empty: { title: string } };
  ext: { schema: string; data: { rows: { id: string; url: string | null }[]; note: { tone: string; text: string } | null } };
};
const loaded = async (path: string): Promise<Model> => {
  const res = await view(path);
  expect(res.status).toBe(200);
  return (await res.json()) as Model;
};

async function setPlugin(plugin: "billing" | "payments", enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc.from("mgm_plugins").upsert({ org_id: ORG, plugin_name: plugin, version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[send-queue.db] mgm_plugins: ${error.message}`);
}

async function setMerchant(patch: Record<string, unknown>) {
  const svc = await serviceClient();
  const { error } = await svc.from("payment_merchant_accounts").update(patch).eq("id", MERCHANT);
  if (error) throw new Error(`[send-queue.db] merchant: ${error.message}`);
}

// payment_merchant_versions references organizations without ON DELETE
// CASCADE, so its rows go first, as in credential-canary.db.test.ts; if that
// foreign key gains a cascade, this delete becomes a no-op.
async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  const { error } = await svc.from("payment_merchant_versions").delete().in("org_id", [ORG, OTHER_ORG]);
  if (error) throw new Error(`[send-queue.db] payment_merchant_versions: ${error.message}`);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, OTHER_EMAIL, TENANT_EMAIL] });
}

/** A bill with every key spelled out: a multi-row insert sends the union of the rows' keys. */
const row = (id: string, periodId: string, tenantId: string, o: Record<string, unknown> = {}) => ({
  id,
  billing_period_id: periodId,
  tenant_id: tenantId,
  start_kwh: 100,
  end_kwh: 110,
  usage_kwh: 10,
  tier_breakdown: [{ label: "Lifeline", kwh: 10, amount: 2500 }],
  total_amount: 2500,
  reading_source: "edge",
  payment_status: "unpaid",
  paid_at: null,
  invoice_number: null,
  ...o,
});

const period = (id: string, month: string, last: string, o: Record<string, unknown> = {}) => ({
  id,
  microgrid_id: MICROGRID,
  start_date: `2026-${month}-01`,
  end_date: `2026-${month}-${last}`,
  timezone: "Africa/Kampala",
  status: "draft",
  closed_at: null,
  rate_schedule_id: SCHEDULE,
  ...o,
});

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  // Payments builds its repository with a service-role client
  // (createSupabasePaymentsRepository in src/lib/payments/compose.ts), made
  // from SUPABASE_SERVICE_ROLE_KEY and the server Supabase URL, where
  // SUPABASE_INTERNAL_URL wins over MGM_PUBLIC_SUPABASE_URL (src/lib/supabase/service.ts);
  // readiness itself reads through the person's client. The links use
  // MGM_APP_URL. If either file reads other names, revisit.
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", await mintServiceRoleJwt());
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", LOCAL_SUPABASE_URL);
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
  vi.stubEnv("MGM_APP_URL", ORIGIN);
  // Before any client exists, so every request a client makes passes through it.
  fetchSpy = vi.spyOn(globalThis, "fetch");
  await cleanup();
  const svc = await serviceClient();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "GUI Send Org" }, { id: OTHER_ORG, name: "GUI Send Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "GUI Send Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI Send Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "Send site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: SECOND_MICROGRID, community_id: COMMUNITY, name: "Second send site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: OTHER_MICROGRID, community_id: OTHER_COMMUNITY, name: "Other send site", currency: "UGX", timezone: "Africa/Kampala" },
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
    [
      "tenants",
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        id: tenant(n),
        microgrid_id: MICROGRID,
        display_name: `Send unit ${n}`,
        // Unit 7 has no email and an empty phone: no contact, as checkout tests it.
        primary_email: n === 1 ? TENANT_CONTACT : null,
        primary_phone: n === 1 || n === 7 ? "" : `+25670000080${n}`,
      })),
    ],
    [
      "billing_periods",
      [period(DRAFT, "10", "31"), period(CLOSED, "09", "30", { status: "closed", closed_at: "2026-10-03T09:00:00+00:00" }), period(EMPTY, "08", "31")],
    ],
    [
      "billing_line_items",
      [
        row(bill(1), DRAFT, tenant(1)),
        row(bill(2), DRAFT, tenant(2), { payment_status: "link_generated" }),
        row(bill(3), DRAFT, tenant(3), { payment_status: "failed" }),
        row(bill(4), DRAFT, tenant(4), { payment_status: "paid", paid_at: "2026-11-02T10:00:00+00:00" }),
        row(bill(5), DRAFT, tenant(5), { payment_status: "refunded", paid_at: "2026-11-02T10:00:00+00:00" }),
        row(bill(6), DRAFT, tenant(6), { usage_kwh: null, tier_breakdown: [], total_amount: 0 }),
        row(bill(7), DRAFT, tenant(7)),
        row(bill(11), CLOSED, tenant(1), { invoice_number: "SEND-2026-00011" }),
      ],
    ],
    // The organization's default Pesapal account, tested and registered, so readiness is "ready".
    [
      "payment_merchant_accounts",
      { id: MERCHANT, org_id: ORG, provider: "pesapal", is_default: true, sandbox: false, last_test_status: "success", ipn_id: "ipn-test" },
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[send-queue.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
  tenantUser = await createTestUser({ email: TENANT_EMAIL, role: "tenant", scopeId: tenant(1) });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
  fetchSpy?.mockRestore();
  vi.unstubAllEnvs();
}, 60_000);

describe.skipIf(shouldSkip())("GET /api/gui/view: a period's send queue", () => {
  it("shows a draft's bills with a link where checkout would accept one, and a note where not", async () => {
    caller = manager;
    await setPlugin("billing", true);
    const res = await view(href(DRAFT));
    expect(res.status).toBe(200);
    const model = await res.json();
    expect(model).toMatchObject({
      type: "view",
      view: "billing.send-queue",
      kind: "collection",
      org: ORG,
      title: "Send October 2026 bills",
      subtitle: "Africa/Kampala",
      entity: { kind: "billingPeriod", id: DRAFT },
      live: { refreshSeconds: 30, staleAfterSeconds: 120 },
    });
    expect(model).not.toHaveProperty("notice");
    const rows = model.body.rows as Row[];
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7].map(bill));
    expect(rows.map((r) => (r.cells.link.t === "text" ? r.cells.link.text : null))).toEqual([link(bill(1)), link(bill(2)), link(bill(3)), null, null, null, null]);
    expect(rows.map((r) => (r.cells.note.t === "text" ? r.cells.note.text : null))).toEqual([
      null,
      null,
      null,
      "Paid: no link to send.",
      "Refunded: no link to send.",
      "Nothing to collect.",
      "No email or phone for this tenant, so checkout would refuse. Add one on the tenant's page.",
    ]);
    // The ext carries the same links, row for row, and no readiness note while ready.
    expect(model.ext.schema).toBe("billing.send-queue@1");
    expect(model.ext.data.rows).toEqual(rows.map((r) => ({ id: r.id, url: r.cells.link.t === "text" ? r.cells.link.text : null })));
    expect(model.ext.data.note).toBeNull();
    // No actions anywhere; each bill's PDF; the period's own links; the trail.
    expect(model.actions).toEqual([]);
    expect(rows.every((r) => r.actions.length === 0)).toBe(true);
    expect(rows[0].links).toEqual([expect.objectContaining({ id: "billing.download-bill", href: `/api/billing-line-items/${bill(1)}/pdf` })]);
    expect(model.links.map((l: { id: string; href: string }) => [l.id, l.href])).toEqual([
      ["billing.back-to-period", `/microgrids/${MICROGRID}/billing/${DRAFT}`],
      ["billing.view-history", `/microgrids/${MICROGRID}/billing/${DRAFT}/history`],
    ]);
    expect(model.trail.map((c: { label: string }) => c.label)).toContain("Send site");
    // The tenant's email address never reaches the model.
    expect(JSON.stringify(model)).not.toContain(TENANT_CONTACT);
  });

  it("links a closed period's unpaid bill too", async () => {
    caller = manager;
    const model = await loaded(href(CLOSED));
    expect(model.title).toBe("Send September 2026 bills");
    expect(model.body.rows.map((r) => r.cells.link)).toEqual([{ t: "text", text: link(bill(11)) }]);
  });

  it("says when links come from a sandbox account", async () => {
    caller = manager;
    await setMerchant({ sandbox: true });
    try {
      const model = await loaded(href(DRAFT));
      expect(model.subtitle).toBe("Sandbox payment links");
      expect(model.ext.data.note).toEqual({ tone: "info", text: "Payment links use a sandbox account: payments made through them are tests." });
      expect(model.ext.data.rows[0].url).toBe(link(bill(1)));
    } finally {
      await setMerchant({ sandbox: false });
    }
  });

  it("shows no links with no payment provider, and tells an organization manager to ask a super admin", async () => {
    caller = manager;
    await setMerchant({ is_default: false });
    try {
      const model = await loaded(href(DRAFT));
      expect(model.subtitle).toBe("No payment provider");
      expect(model.ext.data.note).toEqual({
        tone: "warning",
        text: "No payment provider is configured. Ask a super admin to configure Payment for this community.",
      });
      expect(model.ext.data.rows.every((r) => r.url === null)).toBe(true);
      expect(model.body.rows.every((r) => r.cells.link.t === "empty")).toBe(true);
    } finally {
      await setMerchant({ is_default: true });
    }
  });

  // getReadiness answers "connection_error" for a disabled account and for one
  // that failed its last connection test alike, so the note names both causes
  // (and a dangling override, the third); if those become separate states, revisit.
  it.each([
    ["the account is disabled", { disabled: true }, { disabled: false }],
    ["the account failed its last connection test", { last_test_status: "auth_failed" }, { last_test_status: "success" }],
  ] as const)("shows no links when %s, with a note true of every cause", async (_label, patch, restore) => {
    caller = manager;
    await setMerchant(patch);
    try {
      const model = await loaded(href(DRAFT));
      expect(model.subtitle).toBe("Payment account not connected");
      expect(model.ext.data.note).toEqual({
        tone: "warning",
        text: "The community's payment account cannot take payments: it is disabled, missing, or failed its last connection test. There are no links to send. Ask a super admin to configure Payment for this community.",
      });
      expect(model.ext.data.rows.every((r) => r.url === null)).toBe(true);
    } finally {
      await setMerchant(restore);
    }
  });

  it("shows no links while online payments are turned off", async () => {
    caller = manager;
    await setPlugin("payments", false);
    try {
      const model = await loaded(href(DRAFT));
      expect(model.subtitle).toBe("Online payments are off");
      expect(model.ext.data.note?.text).toBe("Online payments are turned off for this organization, so there are no links to send.");
      expect(model.ext.data.rows.every((r) => r.url === null)).toBe(true);
    } finally {
      await setPlugin("payments", true);
    }
  });

  it("shows the empty state for a period with no bills", async () => {
    caller = manager;
    const model = await loaded(href(EMPTY));
    expect(model.body.rows).toEqual([]);
    expect(model.body.empty.title).toBe("No bills to send yet.");
    // Readiness is not read with nothing to send, and the queue does not claim it could not be.
    expect(model.subtitle).toBe("Africa/Kampala");
    expect(model.ext.data.note).toBeNull();
  });

  it("finds no period under another microgrid", async () => {
    caller = manager;
    expect((await view(href(DRAFT, SECOND_MICROGRID))).status).toBe(404);
  });

  it("gives another organization's manager nothing", async () => {
    caller = other;
    const res = await view(href(DRAFT));
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("Send unit");
    expect(text).not.toContain("/pay");
  });

  it("gives a tenant of the microgrid nothing", async () => {
    caller = tenantUser;
    const res = await view(href(DRAFT));
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("Send site");
    expect(text).not.toContain("/pay");
  });

  it("still loads while billing is off, with the gate's notice", async () => {
    caller = manager;
    await setPlugin("billing", false);
    try {
      const model = await loaded(href(DRAFT));
      expect(model.notice).toMatchObject({ tone: "warning", text: expect.stringContaining("Billing is disabled") });
      expect(model.body.rows).toHaveLength(7);
    } finally {
      await setPlugin("billing", true);
    }
  });

  it("is linked from the period review as Send bills", async () => {
    caller = manager;
    const review = await loaded(`/microgrids/${MICROGRID}/billing/${DRAFT}`);
    expect(review.links.find((l) => l.id === "billing.send-queue")).toMatchObject({ href: href(DRAFT) });
  });

  it("called nothing but the local Supabase", () => {
    const urls = fetchSpy.mock.calls.map(([input]) => String(input instanceof Request ? input.url : input));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => !u.startsWith(LOCAL_SUPABASE_URL))).toEqual([]);
  });
});
