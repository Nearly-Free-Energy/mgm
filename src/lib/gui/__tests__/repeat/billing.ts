/**
 * The twice-sent cases of the billing plugin's actions (../repeat.db.test.ts),
 * with their fixture: one organization, community and microgrid (UGX,
 * Africa/Kampala) with a rate schedule, and a draft period per month so no
 * case reaches another's rows. Meters are read from a provider registered
 * for this microgrid only.
 *
 * Each case is sent as the person the action is offered to: a manager of the
 * organization, or a super admin for Mark as refunded and Mark as failed,
 * which the payment-status route allows no one else.
 */
import { DELETE as deletePeriod } from "@/app/api/billing-periods/[periodId]/route";
import { POST as closePeriod } from "@/app/api/billing-periods/[periodId]/close/route";
import { POST as generateFromMeters } from "@/app/api/billing-periods/[periodId]/generate-from-meters/route";
import { POST as billFromReadings } from "@/app/api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings/route";
import { POST as createPeriod } from "@/app/api/billing-periods/route";
import { PATCH as paymentStatus } from "@/app/api/billing-line-items/[lineItemId]/payment-status/route";
import { POST as regenerateBill } from "@/app/api/billing-line-items/[lineItemId]/regenerate/route";
import { PATCH as recordUsage } from "@/app/api/billing-line-items/[lineItemId]/usage/route";
import { POST as addGridTariff } from "@/app/api/microgrids/[id]/grid-tariffs/route";
import { PUT as saveSavingsSettings } from "@/app/api/microgrids/[id]/savings-settings/route";
import { parseCloseReview, periodName } from "@/lib/billing/close";
import type { MgmRuntime } from "@/lib/runtime/root";
import { cleanupTestData, createTestUser, serviceClient } from "@/lib/supabase/__tests__/rls.helpers";
import type { Case, CaseModule, Fixture } from "./harness";

const ORG = "e2760000-0000-4000-8000-000000000001";
const COMMUNITY = "e2760000-0000-4000-8001-000000000001";
const MG = "e2760000-0000-4000-8002-000000000001";
const SCHEDULE = "e2760000-0000-4000-8006-000000000001";
const EDGE = "e2760000-0000-4000-8009-000000000001";
const DEVICE = "e2760000-0000-4000-8007-000000000001";
/** The period of 2026's month `m`. */
const period = (m: number) => `e2760000-0000-4000-8003-${String(m).padStart(12, "0")}`;
const tenant = (n: number) => `e2760000-0000-4000-8004-${String(n).padStart(12, "0")}`;
const bill = (n: number) => `e2760000-0000-4000-8005-${String(n).padStart(12, "0")}`;
const EMAILS = { manager: "repeat-billing-manager@test.local", superAdmin: "repeat-billing-admin@test.local" };
const PROVIDER = "repeat-db-billing";

/** 30 kWh at the schedule's tiers: 15 at 250 and 15 at 750. */
const BILL_30 = {
  start_kwh: 100,
  end_kwh: 130,
  usage_kwh: 30,
  tier_breakdown: [
    { label: "Lifeline", kwh: 15, amount: 3750 },
    { label: "Standard", kwh: 15, amount: 11250 },
  ],
  total_amount: 15000,
  reading_source: "manual",
  manual_reason: "Dial photo",
};

const paymentCase = (n: number, as: Case["as"], body: Record<string, unknown>): readonly Case[] => [
  { as, params: { lineItemId: bill(n) }, body: () => body, first: 200, second: 400 },
];

let unregister: (() => void) | null = null;

export const BILLING_CASES: CaseModule = {
  handlers: {
    "POST /api/billing-periods": createPeriod,
    "DELETE /api/billing-periods/[periodId]": deletePeriod,
    "POST /api/billing-periods/[periodId]/close": closePeriod,
    "POST /api/billing-periods/[periodId]/generate-from-meters": generateFromMeters,
    "POST /api/billing-periods/[periodId]/tenants/[tenantId]/bill-from-readings": billFromReadings,
    "POST /api/billing-line-items/[lineItemId]/regenerate": regenerateBill,
    "PATCH /api/billing-line-items/[lineItemId]/usage": recordUsage,
    "PATCH /api/billing-line-items/[lineItemId]/payment-status": paymentStatus,
    "PUT /api/microgrids/[id]/savings-settings": saveSavingsSettings,
    "POST /api/microgrids/[id]/grid-tariffs": addGridTariff,
  },
  cases: {
    // The second send overlaps the period the first created: 409.
    "billing.create-period": [
      { as: "manager", params: {}, body: () => ({ microgrid_id: MG, start_date: "2027-01-01", end_date: "2027-01-31" }), first: 201, second: 409 },
    ],
    // The period is gone: 404.
    "billing.delete-period": [
      {
        as: "manager",
        params: { periodId: period(1) },
        body: () => ({ confirmation: { acknowledged: [], typed: periodName("2026-01-01", "2026-01-31") } }),
        first: 200,
        second: 404,
      },
    ],
    // Closed against the review the manager reads: the second is refused as closed, 409.
    "billing.close-period": [
      {
        as: "manager",
        params: { periodId: period(2) },
        body: async (caller) => {
          const { data, error } = await caller.client.rpc("fn_billing_period_close_review", { _period_id: period(2) });
          const review = parseCloseReview(data);
          if (error || !review) throw new Error(`[repeat] close review: ${error?.message ?? "not a review"}`);
          return { confirmation: { digest: review.digest, acknowledged: review.acknowledgements.map((a) => a.id), typed: review.name } };
        },
        first: 200,
        second: 409,
      },
    ],
    // The bill already has the meter's figures: 200, nothing generated.
    "billing.generate-from-meters": [{ as: "manager", params: { periodId: period(3) }, body: () => ({}), first: 200, second: 200 }],
    // The tenant now has a bill: 409 has_bill.
    "billing.bill-from-readings": [
      { as: "manager", params: { periodId: period(4), tenantId: tenant(4) }, body: () => ({ start_kwh: 100, end_kwh: 150 }), first: 201, second: 409 },
    ],
    // The bill already has these figures: 200, changed false.
    "billing.regenerate-bill": [
      {
        as: "manager",
        params: { lineItemId: bill(5) },
        body: () => ({ readings: "manual", start_kwh: 100, end_kwh: 190, reason: "Read twice" }),
        first: 200,
        second: 200,
      },
    ],
    // The bill already has this usage: 200, the bill as it was.
    "billing.record-usage": [{ as: "manager", params: { lineItemId: bill(6) }, body: () => ({ usage_kwh: 70 }), first: 200, second: 200 }],
    // The bill is already in that state: 400 no_op.
    "billing.mark-paid": paymentCase(71, "manager", { status: "paid", notes: "Paid in cash" }),
    "billing.mark-unpaid": paymentCase(72, "manager", { status: "unpaid" }),
    "billing.mark-refunded": paymentCase(73, "superAdmin", { status: "refunded", confirmation: { acknowledged: [], typed: "Tenant 73" } }),
    "billing.mark-failed": paymentCase(74, "superAdmin", { status: "failed" }),
    "billing.cancel-payment-link": paymentCase(75, "manager", { status: "unpaid" }),
    // The same settings again: 200.
    "billing.savings-settings": [
      {
        as: "manager",
        params: { id: MG },
        body: () => ({ solar_savings_from: "2026-01-01", arbitrage_from: null, round_trip_efficiency: 0.9 }),
        first: 200,
        second: 200,
        ignore: [
          // The route stamps the upsert with the time of the request, so a
          // second save of the same values moves only this. No reader shows
          // or compares it (the Rates page selects it and shows no date). If
          // anything comes to show or compare it, remove this, and make the
          // route skip an unchanged row instead.
          { column: "microgrid_savings_settings.updated_at", row: { microgrid_id: MG }, reason: "stamped on every save, read by nothing" },
        ],
      },
    ],
    // A version already starts that day: 409.
    "billing.grid-tariff-add": [
      {
        as: "manager",
        params: { id: MG },
        body: () => ({ effective_from: "2026-09-01", bands: [{ from_hour: 0, to_hour: 24, rate: 500 }] }),
        first: 201,
        second: 409,
      },
    ],
  },

  async cleanup() {
    unregister?.();
    unregister = null;
    await cleanupTestData({ orgIds: [ORG], userEmails: Object.values(EMAILS) });
  },

  async seed(runtime: MgmRuntime): Promise<Fixture> {
    const svc = await serviceClient();
    const now = new Date().toISOString();
    const draft = (m: number) => {
      const end = new Date(Date.UTC(2026, m, 0)).getUTCDate();
      const month = String(m).padStart(2, "0");
      return {
        id: period(m),
        microgrid_id: MG,
        start_date: `2026-${month}-01`,
        end_date: `2026-${month}-${end}`,
        timezone: "Africa/Kampala",
        status: "draft",
        rate_schedule_id: SCHEDULE,
      };
    };
    // One insert of several rows sends every key for every row, so each row
    // spells out the payment columns any of them sets.
    const line = (n: number, m: number, o: Record<string, unknown> = {}) => ({
      id: bill(n),
      billing_period_id: period(m),
      tenant_id: tenant(n),
      ...BILL_30,
      payment_status: "unpaid",
      paid_at: null,
      pesapal_order_id: null,
      pesapal_redirect_url: null,
      ...o,
    });
    const linked = (n: number) => ({
      payment_status: "link_generated",
      pesapal_order_id: `order-repeat-${n}`,
      pesapal_redirect_url: `https://pay.invalid/repeat-${n}`,
    });
    const units = [2, 3, 4, 5, 6, 71, 72, 73, 74, 75];
    const rows: [string, Record<string, unknown> | Record<string, unknown>[]][] = [
      ["organizations", { id: ORG, name: "Repeat Billing Org" }],
      ["communities", { id: COMMUNITY, org_id: ORG, name: "Repeat Billing Community" }],
      ["microgrids", { id: MG, community_id: COMMUNITY, name: "Repeat Billing site", currency: "UGX", timezone: "Africa/Kampala" }],
      [
        "rate_schedules",
        {
          id: SCHEDULE,
          microgrid_id: MG,
          tiers: [
            { label: "Lifeline", min_kwh: 1, max_kwh: 15, rate_per_kwh: 250 },
            { label: "Standard", min_kwh: 16, max_kwh: null, rate_per_kwh: 750 },
          ],
          service_charge: 0,
          tax_rate: 0,
        },
      ],
      ["edges", { id: EDGE, microgrid_id: MG, name: "Repeat Billing edge", openems_edge_id: "repeat-billing-edge" }],
      ["devices", { id: DEVICE, edge_id: EDGE, name: "Meter 3", device_type: "consumption_meter", openems_component_id: "meter3" }],
      [
        "tenants",
        units.map((n) => ({ id: tenant(n), microgrid_id: MG, display_name: `Tenant ${n}`, primary_phone: `+256700276${String(n).padStart(3, "0")}` })),
      ],
      // Only tenant 3 has a meter, so the usage correction's tenant 6 is unmetered.
      ["tenant_devices", { tenant_id: tenant(3), device_id: DEVICE, role: "primary_consumption_meter", effective_from: "2026-01-01" }],
      ["billing_periods", [1, 2, 3, 4, 5, 6, 7].map(draft)],
      [
        "billing_line_items",
        [
          line(2, 2),
          line(5, 5),
          line(6, 6),
          line(71, 7),
          line(72, 7, { payment_status: "paid", paid_at: now }),
          line(73, 7, { payment_status: "paid", paid_at: now }),
          line(74, 7, linked(74)),
          line(75, 7, linked(75)),
        ],
      ],
    ];
    for (const [table, value] of rows) {
      const { error } = await svc.from(table).insert(value);
      if (error) throw new Error(`[repeat billing] ${table}: ${error.message}`);
    }
    // 40 kWh for every meter of this microgrid, in every period.
    unregister = runtime.meteringProviders.register(
      PROVIDER,
      () => ({
        getReadings: async ({ devices, startDate, endDate }) => devices.map((d) => ({ deviceId: d.id, usageKwh: 40, startDate, endDate })),
      }),
      { supports: async (_client, microgridId) => microgridId === MG },
    );
    return {
      orgId: ORG,
      users: {
        manager: await createTestUser({ email: EMAILS.manager, role: "org_manager", scopeId: ORG }),
        superAdmin: await createTestUser({ email: EMAILS.superAdmin, role: "super_admin" }),
      },
    };
  },
};
