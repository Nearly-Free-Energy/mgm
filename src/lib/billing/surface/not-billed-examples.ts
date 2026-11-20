import "server-only";

/**
 * Examples of the `billing.not-billed` view, so every GUI can be tested
 * against it: a draft with three tenants not billed, one for each reason,
 * each offered Bill from readings; the same while billing is off, with the
 * action disabled and the gate's notice; a closed period, whose tenants not
 * billed are listed with no action; a draft where every tenant has a bill;
 * and a microgrid with no tenants. Built at import the way the loader builds
 * them.
 */
import type { ActionRef, ModelOf } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import type { ActionLink, LoadedModel } from "@/lib/gui/surface";
import type { PrimaryMeterLink } from "../meter-coverage";
import { periodLabel } from "./period-label";
import { BILL_FROM_READINGS_ACTION, buildNotBilledModel, NOT_BILLED_VIEW, type NotBilledInput, type NotBilledTenant } from "./not-billed-model";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const MICROGRID = { id: "00000000-0000-4000-8000-0000000000a1", name: "Example site" };
const fmt = createFmt({ locale: "en-GB" });

/**
 * A copy of the gate's copy for a disabled billing plugin
 * (src/lib/runtime/gate.ts), which the host shows as the notice and as the
 * reason on billing's own actions. If the gate's copy changes, so may this.
 */
const BILLING_DISABLED =
  "Billing is disabled for this organization. Enable it in Settings → Plugins; tariffs, periods, bills, and payment history are preserved.";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const NOVEMBER = { id: id(0xb2), start_date: "2026-11-01", end_date: "2026-11-30", status: "draft" as const };
const OCTOBER = { id: id(0xb1), start_date: "2026-10-01", end_date: "2026-10-31", status: "closed" as const };

const meter = (from: string, to: string | null = null): PrimaryMeterLink => ({
  effective_from: from,
  effective_to: to,
  devices: { openems_component_id: "meter0", edges: { openems_edge_id: "edge0" } },
});
const tenant = (n: number, name: string, links: PrimaryMeterLink[]): NotBilledTenant => ({ id: id(0xc0 + n), display_name: name, primaryLinks: links });
const TENANTS = [
  // Billed in the examples below.
  tenant(1, "Akello Grace", [meter("2026-01-01")]),
  // A meter assigned for the whole period, with no bill from it yet.
  tenant(2, "Byaruhanga Peter", [meter("2026-01-01")]),
  // No meter.
  tenant(3, "Kato Joseph", []),
  // A meter replaced in the middle of November: no one meter for all of it.
  tenant(4, "Nambi Sarah", [meter("2026-01-01", "2026-11-15"), meter("2026-11-15")]),
];

const base = (o: Partial<NotBilledInput>): NotBilledInput => ({
  microgridId: MICROGRID.id,
  period: NOVEMBER,
  tenants: TENANTS,
  billedTenantIds: new Set([TENANTS[0].id]),
  fmt,
  ...o,
});

/** The models as the loader returns them, before the host fills its fields, with the period each is of. */
const CASES: readonly { loaded: LoadedModel<"collection">; period: typeof NOVEMBER | typeof OCTOBER; disabled?: true }[] = [
  // The first names the section where the period review lists it.
  { loaded: buildNotBilledModel(base({})), period: NOVEMBER },
  { loaded: buildNotBilledModel(base({})), period: NOVEMBER, disabled: true },
  { loaded: buildNotBilledModel(base({ period: OCTOBER })), period: OCTOBER },
  { loaded: buildNotBilledModel(base({ billedTenantIds: new Set(TENANTS.map((t) => t.id)) })), period: NOVEMBER },
  { loaded: buildNotBilledModel(base({ tenants: [] })), period: NOVEMBER },
];

export const NOT_BILLED_LOADED_EXAMPLES: readonly LoadedModel<"collection">[] = CASES.map((c) => c.loaded);

const resolve =
  (disabled: boolean) =>
  (link: ActionLink): ActionRef => ({
    ...link,
    label: link.label ?? BILL_FROM_READINGS_ACTION.title,
    ...(disabled ? { enabled: false, reason: BILLING_DISABLED } : { enabled: true }),
  });

/** A loaded model with the fields the host fills, as a GUI receives it; `disabled` as while billing is off. */
function asReceived(loaded: LoadedModel<"collection">, period: { id: string; start_date: string; end_date: string }, disabled: boolean): ModelOf<"collection"> {
  const ref = resolve(disabled);
  return {
    ...loaded,
    type: "view",
    view: NOT_BILLED_VIEW,
    kind: "collection",
    org: ORG,
    // As the host builds it from the path's microgrid and period (src/lib/gui/host/server/entities.ts).
    trail: [
      { label: MICROGRID.name, href: `/microgrids/${MICROGRID.id}` },
      { label: periodLabel(fmt, period.start_date, period.end_date), href: `/microgrids/${MICROGRID.id}/billing/${period.id}` },
    ],
    actions: [],
    links: loaded.links ?? [],
    attached: [],
    body: {
      ...loaded.body,
      rows: loaded.body.rows.map((row) => ({ ...row, actions: row.actions.map(ref) })),
      empty: { title: loaded.body.empty.title },
    },
    ...(disabled ? { notice: { tone: "warning" as const, text: BILLING_DISABLED } } : {}),
  };
}

export const NOT_BILLED_EXAMPLES: readonly ModelOf<"collection">[] = CASES.map((c) => asReceived(c.loaded, c.period, c.disabled === true));
