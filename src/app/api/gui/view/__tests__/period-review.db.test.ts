/**
 * GET /api/gui/view serves one billing period's bills,
 * `billing.period-review`: the route checks the session, the host resolves
 * the microgrid and the period through the person's own client, and the
 * loader reads the pinned tariff, the bills, the tenants and their meters
 * through that client. Marking a bill failed or refunded is offered only to
 * a super admin; another organization's manager gets nothing; while billing
 * is off the review still loads, with the gate's notice and every action
 * disabled; and a period with no pinned tariff is refused.
 *
 * The legacy page still serves /microgrids/[id]/billing/[periodId] in the
 * browser; this reaches the view only through the host's API.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";

let caller: TestUser | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!caller) throw new Error("[period-review.db] no caller");
    return caller.client;
  },
}));

import { GET } from "../route";

const ORG = "e7800000-0000-4000-8000-000000000001";
const OTHER_ORG = "e7800000-0000-4000-8000-000000000002";
const COMMUNITY = "e7800000-0000-4000-8001-000000000001";
const OTHER_COMMUNITY = "e7800000-0000-4000-8001-000000000002";
const MICROGRID = "e7800000-0000-4000-8002-000000000001";
const UNTARIFFED = "e7800000-0000-4000-8002-000000000002";
const OTHER_MICROGRID = "e7800000-0000-4000-8002-000000000003";
const SCHEDULE = "e7800000-0000-4000-8006-000000000001";
const DRAFT = "e7800000-0000-4000-8003-000000000001";
const CLOSED = "e7800000-0000-4000-8003-000000000002";
const NO_TARIFF = "e7800000-0000-4000-8003-000000000003";
const tenant = (n: number) => `e7800000-0000-4000-8004-00000000000${n}`;
const bill = (n: number) => `e7800000-0000-4000-8005-00000000000${n}`;
const EMAIL = "gui-review-manager@test.local";
const SUPER_EMAIL = "gui-review-super@test.local";
const OTHER_EMAIL = "gui-review-other@test.local";

let manager: TestUser;
let admin: TestUser;
let other: TestUser;

const view = (href: string) => GET(new NextRequest(`http://localhost/api/gui/view?href=${encodeURIComponent(href)}`));
const draftHref = `/microgrids/${MICROGRID}/billing/${DRAFT}`;

async function setBilling(enabled: boolean) {
  const svc = await serviceClient();
  const { error } = await svc
    .from("mgm_plugins")
    .upsert({ org_id: ORG, plugin_name: "billing", version: "0.1.0", enabled }, { onConflict: "org_id,plugin_name" });
  if (error) throw new Error(`[period-review.db] mgm_plugins: ${error.message}`);
}

// cleanupTestData purges, as the database owner, the closed period and the
// paid bills the billing retention guards keep from an organization's delete.
async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", [ORG, OTHER_ORG]);
  await cleanupTestData({ orgIds: [ORG, OTHER_ORG], userEmails: [EMAIL, SUPER_EMAIL, OTHER_EMAIL] });
}

/** A bill with every key spelled out: a multi-row insert sends the union of the rows' keys. */
const row = (id: string, periodId: string, tenantId: string, o: Record<string, unknown> = {}) => ({
  id,
  billing_period_id: periodId,
  tenant_id: tenantId,
  start_kwh: 100,
  end_kwh: 150,
  usage_kwh: 50,
  tier_breakdown: [
    { label: "Lifeline", kwh: 15, amount: 3750 },
    { label: "Standard", kwh: 35, amount: 26250 },
  ],
  total_amount: 30000,
  reading_source: "edge",
  payment_status: "unpaid",
  paid_at: null,
  ...o,
});

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  const svc = await serviceClient();
  const paidAt = new Date().toISOString();
  const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
    ["organizations", [{ id: ORG, name: "GUI Review Org" }, { id: OTHER_ORG, name: "GUI Review Other Org" }]],
    [
      "communities",
      [
        { id: COMMUNITY, org_id: ORG, name: "GUI Review Community" },
        { id: OTHER_COMMUNITY, org_id: OTHER_ORG, name: "GUI Review Other Community" },
      ],
    ],
    [
      "microgrids",
      [
        { id: MICROGRID, community_id: COMMUNITY, name: "Review site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: UNTARIFFED, community_id: COMMUNITY, name: "Untariffed site", currency: "UGX", timezone: "Africa/Kampala" },
        { id: OTHER_MICROGRID, community_id: OTHER_COMMUNITY, name: "Other site", currency: "UGX", timezone: "Africa/Kampala" },
      ],
    ],
    // Before the periods, which pin a tariff on insert; set explicitly anyway.
    [
      "rate_schedules",
      {
        id: SCHEDULE,
        microgrid_id: MICROGRID,
        tiers: [
          { label: "Lifeline", min_kwh: 0, max_kwh: 15, rate_per_kwh: 250 },
          { label: "Standard", min_kwh: 15, max_kwh: null, rate_per_kwh: 750 },
        ],
        service_charge: 0,
        tax_rate: 0,
      },
    ],
    [
      "tenants",
      [1, 2, 3, 4, 5].map((n) => ({ id: tenant(n), microgrid_id: MICROGRID, display_name: `Unit ${n}`, primary_phone: `+25670000080${n}` })),
    ],
    [
      "billing_periods",
      [
        { id: DRAFT, microgrid_id: MICROGRID, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala", status: "draft", rate_schedule_id: SCHEDULE },
        {
          id: CLOSED,
          microgrid_id: MICROGRID,
          start_date: "2026-09-01",
          end_date: "2026-09-30",
          timezone: "Africa/Kampala",
          status: "closed",
          closed_at: paidAt,
          rate_schedule_id: SCHEDULE,
        },
        // No tariff on its microgrid, so nothing is pinned.
        { id: NO_TARIFF, microgrid_id: UNTARIFFED, start_date: "2026-10-01", end_date: "2026-10-31", timezone: "Africa/Kampala", status: "draft" },
      ],
    ],
    [
      "billing_line_items",
      [
        row(bill(1), DRAFT, tenant(1)),
        row(bill(2), DRAFT, tenant(2), { payment_status: "paid", paid_at: paidAt }),
        row(bill(3), DRAFT, tenant(3), { payment_status: "link_generated" }),
        row(bill(4), DRAFT, tenant(4), { payment_status: "refunded", paid_at: paidAt }),
        row(bill(5), DRAFT, tenant(5), { reading_source: "manual", start_kwh: 10, end_kwh: 20, usage_kwh: 10, total_amount: 2500 }),
        row(bill(6), CLOSED, tenant(1), { payment_status: "paid", paid_at: paidAt }),
        row(bill(7), CLOSED, tenant(5), { reading_source: "manual", start_kwh: 0, end_kwh: 10, usage_kwh: 10, total_amount: 2500 }),
      ],
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[period-review.db] ${table}: ${error.message}`);
  }
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
  admin = await createTestUser({ email: SUPER_EMAIL, role: "super_admin" });
  other = await createTestUser({ email: OTHER_EMAIL, role: "org_manager", scopeId: OTHER_ORG });
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  caller = null;
  await cleanup();
}, 60_000);

type Row = {
  id: string;
  entity: { kind: string; id: string };
  related: { kind: string; id: string; href: string }[];
  cells: Record<string, { t: string; v?: number; text: string }>;
  actions: { action: string; enabled: boolean; prefill?: unknown; label: string }[];
  links: { id: string; href: string }[];
};
const actionIds = (rows: Row[]) => rows.flatMap((r) => r.actions.map((a) => a.action));

describe.skipIf(shouldSkip())("GET /api/gui/view: a billing period's review", () => {
  it("returns the draft's bills with the pinned tariff's tiers, totals, links and prefilled actions", async () => {
    caller = manager;
    await setBilling(true);
    const res = await view(draftHref);
    expect(res.status).toBe(200);
    const model = await res.json();
    expect(model).toMatchObject({
      type: "view",
      view: "billing.period-review",
      kind: "collection",
      org: ORG,
      entity: { kind: "billingPeriod", id: DRAFT },
      live: { refreshSeconds: 30, staleAfterSeconds: 120 },
    });
    expect(model).not.toHaveProperty("notice");
    expect(model.body.columns.map((c: { key: string }) => c.key)).toEqual([
      "tenant",
      "begin",
      "end",
      "usage",
      "tier.1.kwh",
      "tier.1.amount",
      "tier.2.kwh",
      "tier.2.amount",
      "total",
      "source",
      "payment",
      "entered",
    ]);
    const rows = model.body.rows as Row[];
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5].map(bill));
    expect(rows[0].entity).toMatchObject({ kind: "lineItem", id: bill(1) });
    expect(rows[0].related).toEqual([expect.objectContaining({ kind: "tenant", id: tenant(1), href: `/microgrids/${MICROGRID}/setup/tenants/${tenant(1)}` })]);
    expect(model.body.totals.usage).toMatchObject({ t: "energy", v: 210 });
    expect(model.body.totals.total).toMatchObject({ t: "money", v: 122500, currency: "UGX" });
    expect(model.actions).toMatchObject([{ action: "billing.generate-bills", params: { billingPeriodId: DRAFT }, enabled: true, label: "Refresh readings" }]);
    expect(model.links.map((l: { id: string }) => l.id)).toEqual(["billing.view-history", "billing.export-csv"]);
    expect(rows[0].links.map((l) => l.id)).toEqual(["billing.download-bill", "billing.view-history"]);

    // The prefills survive the host's check against each input.
    const switchToManual = rows[0].actions.find((a) => a.label === "Switch to manual entry");
    expect(switchToManual?.prefill).toEqual({ readings: "manual", start_kwh: 100 });
    expect(rows[1].actions.find((a) => a.action === "billing.mark-unpaid")?.prefill).toEqual({ status: "unpaid" });
    // An organization manager is not offered marking failed or refunded.
    expect(actionIds(rows)).not.toContain("billing.mark-refunded");
    expect(actionIds(rows)).not.toContain("billing.mark-failed");
    // No regenerate and no payment change on the refunded bill; its usage can still be corrected, as legacy and the usage route allow.
    expect(rows[3].actions.map((a) => a.action)).toEqual(["billing.record-usage"]);
    // The unmetered manual bill on a draft can have its usage corrected.
    expect(rows[4].actions.map((a) => a.action)).toContain("billing.record-usage");
  });

  it("offers a super admin marking a bill failed or refunded", async () => {
    caller = admin;
    const res = await view(draftHref);
    expect(res.status).toBe(200);
    const rows = (await res.json()).body.rows as Row[];
    expect(rows[1].actions.map((a) => a.action)).toContain("billing.mark-refunded");
    expect(rows[2].actions.map((a) => a.action)).toContain("billing.mark-failed");
  });

  it("offers neither Generate nor a usage correction on a closed period", async () => {
    caller = manager;
    const res = await view(`/microgrids/${MICROGRID}/billing/${CLOSED}`);
    expect(res.status).toBe(200);
    const model = await res.json();
    expect(model.actions).toEqual([]);
    expect(actionIds(model.body.rows)).not.toContain("billing.record-usage");
    expect(actionIds(model.body.rows)).toContain("billing.regenerate-bill");
  });

  it("finds no period under another microgrid", async () => {
    caller = manager;
    const res = await view(`/microgrids/${UNTARIFFED}/billing/${DRAFT}`);
    expect(res.status).toBe(404);
  });

  it("gives another organization's manager nothing", async () => {
    caller = other;
    const res = await view(draftHref);
    expect([403, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("Unit 1");
    expect(text).not.toContain("Review site");
  });

  it("still loads while billing is off, with the gate's notice and every action disabled", async () => {
    caller = manager;
    await setBilling(false);
    try {
      const res = await view(draftHref);
      expect(res.status).toBe(200);
      const model = await res.json();
      expect(model.notice).toMatchObject({ tone: "warning", text: expect.stringContaining("Billing is disabled") });
      expect(model.actions).toMatchObject([{ action: "billing.generate-bills", enabled: false, reason: model.notice.text }]);
      const actions = (model.body.rows as Row[]).flatMap((r) => r.actions);
      expect(actions.length).toBeGreaterThan(0);
      for (const a of actions) expect(a.enabled).toBe(false);
    } finally {
      await setBilling(true);
    }
  });

  it("refuses a period with no pinned tariff", async () => {
    caller = manager;
    const res = await view(`/microgrids/${UNTARIFFED}/billing/${NO_TARIFF}`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("no pinned tariff");
  });
});
