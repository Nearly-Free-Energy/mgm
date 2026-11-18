import "server-only";

/**
 * Examples of the `billing.period-review` view, so every GUI can be tested
 * against it: a draft period seen by an organization manager, with an edge
 * bill, a manual paid one, one with a pending payment link and a refunded
 * one; a closed period seen by a super admin, who is also offered marking a
 * bill failed or refunded; a draft with tenants and no bills, whose empty
 * state offers Generate; a microgrid with no tenants; and the first again
 * while billing is off, with every action disabled and the gate's notice.
 * Built at import the way the loader builds them.
 */
import type { ActionRef, ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionLink, LoadedModel } from "@/lib/gui/surface";
import {
  buildPeriodReviewModel,
  CANCEL_PAYMENT_LINK_ACTION,
  GENERATE_BILLS_ACTION,
  MARK_FAILED_ACTION,
  MARK_PAID_ACTION,
  MARK_REFUNDED_ACTION,
  MARK_UNPAID_ACTION,
  RECORD_USAGE_ACTION,
  REGENERATE_BILL_ACTION,
  type PeriodReviewInput,
  type ReviewBill,
} from "./period-review-model";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = { id: "00000000-0000-4000-8000-0000000000a1", name: "Example site", currency: "UGX" };
const fmt = createFmt({ locale: "en-GB" });

/**
 * A copy of the gate's copy for a disabled billing plugin
 * (src/lib/runtime/gate.ts), which the host shows as the notice and as the
 * reason on billing's own actions. If the gate's copy changes, so may this.
 */
const BILLING_DISABLED =
  "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.";

const TITLES: Record<string, string> = Object.fromEntries(
  [
    GENERATE_BILLS_ACTION,
    REGENERATE_BILL_ACTION,
    RECORD_USAGE_ACTION,
    MARK_PAID_ACTION,
    MARK_UNPAID_ACTION,
    MARK_REFUNDED_ACTION,
    MARK_FAILED_ACTION,
    CANCEL_PAYMENT_LINK_ACTION,
  ].map((a) => [a.id, a.title]),
);

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const NOVEMBER = { id: id(0xb2), start_date: "2026-11-01", end_date: "2026-11-30", status: "draft" as const, timezone: "Africa/Kampala" };
const OCTOBER = { id: id(0xb1), start_date: "2026-10-01", end_date: "2026-10-31", status: "closed" as const, timezone: "Africa/Kampala" };
const TIERS = [{ label: "Lifeline" }, { label: "Standard" }];

const tenant = (n: number, name: string, o: { edgeAvailable?: boolean; meterLinkInPeriod?: boolean } = {}) => ({
  id: id(0xc0 + n),
  display_name: name,
  edgeAvailable: o.edgeAvailable ?? true,
  meterLinkInPeriod: o.meterLinkInPeriod ?? true,
});
const TENANTS = [
  tenant(1, "Akello Grace"),
  tenant(2, "Byaruhanga Peter", { edgeAvailable: false, meterLinkInPeriod: false }),
  tenant(3, "Kato Joseph"),
  tenant(4, "Nambi Sarah"),
];

const bill = (n: number, tenantIndex: number, o: Partial<ReviewBill>): ReviewBill => ({
  id: id(0xd0 + n),
  tenant_id: TENANTS[tenantIndex].id,
  device_id: id(0xe0 + n),
  start_kwh: 1200,
  end_kwh: 1284.5,
  usage_kwh: 84.5,
  tier_breakdown: [
    { label: "Lifeline", kwh: 15, amount: 3750 },
    { label: "Standard", kwh: 69.5, amount: 52125 },
  ],
  total_amount: 55875,
  reading_source: "edge",
  payment_status: "unpaid",
  invoice_number: null,
  entered_at: null,
  entered_by: null,
  ...o,
});

const base = (o: Partial<PeriodReviewInput>): PeriodReviewInput => ({
  microgrid: MICROGRID,
  period: NOVEMBER,
  tiers: TIERS,
  tenants: TENANTS,
  bills: [],
  superAdmin: false,
  fmt,
  ...o,
});

/** The models as the loader returns them, before the host fills its fields. */
export const PERIOD_REVIEW_LOADED_EXAMPLES: readonly LoadedModel<"collection">[] = [
  // A draft, seen by an organization manager.
  buildPeriodReviewModel(
    base({
      bills: [
        bill(1, 0, { invoice_number: "EXS-2026-0001" }),
        bill(2, 1, {
          device_id: null,
          start_kwh: 310,
          end_kwh: 352,
          usage_kwh: 42,
          tier_breakdown: [
            { label: "Lifeline", kwh: 15, amount: 3750 },
            { label: "Standard", kwh: 27, amount: 20250 },
          ],
          total_amount: 24000,
          reading_source: "manual",
          payment_status: "paid",
          entered_at: "2026-11-30T15:20:00Z",
          entered_by: "Okello Daniel",
        }),
        bill(3, 2, { payment_status: "link_generated" }),
        bill(4, 3, { payment_status: "refunded", invoice_number: "EXS-2026-0004" }),
      ],
    }),
  ),
  // A closed period, seen by a super admin.
  buildPeriodReviewModel(
    base({
      period: OCTOBER,
      superAdmin: true,
      tenants: TENANTS.slice(0, 3),
      bills: [
        bill(5, 0, { payment_status: "paid", invoice_number: "EXS-2026-0005" }),
        bill(6, 1, { device_id: null, reading_source: "manual", payment_status: "link_generated", entered_at: "2026-10-31T09:00:00Z" }),
        bill(7, 2, { payment_status: "failed", usage_kwh: null, tier_breakdown: null, total_amount: 0 }),
      ],
    }),
  ),
  // A draft with tenants and no bills yet.
  buildPeriodReviewModel(base({})),
  // A microgrid with no tenants.
  buildPeriodReviewModel(base({ tenants: [] })),
];

const resolve =
  (disabled: boolean) =>
  (link: ActionLink): ActionRef => ({
    ...link,
    label: link.label ?? TITLES[link.action],
    ...(disabled ? { enabled: false, reason: BILLING_DISABLED } : { enabled: true }),
  });

/** A loaded model with the fields the host fills, as a GUI receives it; `disabled` as while billing is off. */
function asReceived(loaded: LoadedModel<"collection">, disabled = false): ModelOf<"collection"> {
  const ref = resolve(disabled);
  const { empty } = loaded.body;
  return {
    ...loaded,
    type: "view",
    view: "billing.period-review",
    kind: "collection",
    org: ORG,
    trail: [
      { label: MICROGRID.name, href: `/microgrids/${MICROGRID.id}` },
      { label: "Billing", href: `/microgrids/${MICROGRID.id}/billing` },
    ],
    actions: loaded.actions.map(ref),
    links: loaded.links ?? [],
    attached: [],
    live: { refreshSeconds: 30, staleAfterSeconds: 120 },
    body: {
      ...loaded.body,
      rows: loaded.body.rows.map((row) => ({ ...row, actions: row.actions.map(ref) })),
      empty: { title: empty.title, ...(empty.text ? { text: empty.text } : {}), ...(empty.action ? { action: ref(empty.action) } : {}) },
    },
    ...(disabled ? { notice: { tone: "warning" as const, text: BILLING_DISABLED } } : {}),
  };
}

export const PERIOD_REVIEW_EXAMPLES: readonly ModelOf<"collection">[] = [
  ...PERIOD_REVIEW_LOADED_EXAMPLES.map((loaded) => asReceived(loaded)),
  asReceived(PERIOD_REVIEW_LOADED_EXAMPLES[0], true),
];
