/**
 * not-billed-model.ts — the tenants of a period's microgrid who have no bill
 * for it, and why, as a `collection` view model (`billing.not-billed`), a
 * section of the period review, with Bill from readings on each one while
 * the period is a draft.
 *
 * Pure: no server-only import, no clock, no I/O. Every string a renderer
 * shows is built here.
 *
 * The review's rows are bills, so a tenant with no bill is not one of them.
 * Generating from meter data bills no tenant with no meter for the period, a
 * meter assignment gap or no meter data (#293), and regenerating and
 * correcting usage both need a bill, so this section lists those tenants and
 * offers billing each from readings typed by hand
 * (`billing.bill-from-readings`, parity.ts). It also carries what the legacy
 * page's banner of tenants not billed said (BillingTable, #293), and more:
 * the banner named only tenants with no available meter, and only once the
 * period had a bill.
 *
 * Every tenant with no bill is listed, before the first bill too: a period
 * whose metered tenants all have no meter data gets no bill from generating,
 * and this is then the only way to bill them. The reason is meterCoverage's
 * (../meter-coverage.ts), the choice the bill engine makes, so it says why
 * generating did not bill the tenant, or would not: a metered tenant's
 * meter may still have no data, which only a run finds. In a closed period
 * no run can bill them, so a metered tenant's reason says only that their
 * meter gave them no bill for it.
 *
 * A closed period leaves out the tenants who came onto the microgrid only
 * after it closed (joinedAfterPeriod): they were not its tenants, and
 * nothing can bill them in it. A draft lists them, since a draft can still
 * bill them from readings, as when a tenant is recorded late.
 */
import type { ActionLink, Fmt, LoadedModel } from "@/lib/gui/surface";
import { dayKeyInZone } from "@/lib/timezone/day-key";
import { meterCoverage, type MeterCoverage, type PrimaryMeterLink } from "../meter-coverage";

export const NOT_BILLED_VIEW = "billing.not-billed";

/** Every cell key the view emits. */
export const NOT_BILLED_KEYS = ["tenant", "reason"] as const;

/**
 * The view's title. Constant: the host takes an attached view's title from
 * its first example (attachedViews in src/lib/gui/host/server/view.ts), so
 * the review lists the section under this name whatever the period. If
 * attachedViews stops taking examples[0].title, or a nav entry for this view
 * gives it a title of its own (which attachedViews prefers), revisit.
 */
export const NOT_BILLED_TITLE = "Tenants not billed";

/** The billing action each row offers; BILLING_SURFACE (../surface.ts) defines it. */
export const BILL_FROM_READINGS_ACTION = { id: "billing.bill-from-readings", title: "Bill from readings" } as const;

/**
 * Why a tenant has no bill in a draft, by meterCoverage's answer. A metered
 * tenant has none yet because no run from meter data billed them: none has
 * run, or their meter had no data for the period.
 */
export const NOT_BILLED_REASON = {
  no_meter: "No meter for this period",
  assignment_gap: "Meter assignment gap in this period",
  metered: "No bill from its meter yet",
} as const satisfies Record<MeterCoverage, string>;

/**
 * Why a tenant has no bill in a closed period. A metered tenant's reason
 * promises nothing: generate-from-meters refuses a closed period, and a
 * closed period is never reopened (trg_billing_period_stays_closed). If
 * either changes, revisit.
 */
export const NOT_BILLED_CLOSED_REASON = {
  ...NOT_BILLED_REASON,
  metered: "No bill from its meter for this period",
} as const satisfies Record<MeterCoverage, string>;

/** The reason a row gives, by the period's status and meterCoverage's answer. */
export const notBilledReason = (status: "draft" | "closed", coverage: MeterCoverage): string =>
  (status === "closed" ? NOT_BILLED_CLOSED_REASON : NOT_BILLED_REASON)[coverage];

export const NOT_BILLED_COPY = {
  subtitle: "These tenants have no bill for this period.",
  noTenants: "No tenants configured for this microgrid.",
  allBilled: "Every tenant has a bill for this period.",
} as const;

/** The view's own page, under the period whose review it is a section of. */
export const notBilledHref = (microgridId: string, periodId: string): `/${string}` =>
  `/microgrids/${microgridId}/billing/${periodId}/not-billed`;

export type NotBilledTenant = {
  id: string;
  display_name: string;
  primaryLinks: readonly PrimaryMeterLink[];
  /** When the tenant's record was created (tenants.created_at). */
  created_at: string;
};

export type NotBilledPeriod = {
  id: string;
  start_date: string;
  end_date: string;
  status: "draft" | "closed";
  timezone: string;
  /** When the period was closed (billing_periods.closed_at); null for a draft. */
  closed_at: string | null;
};

/**
 * Whether a tenant came onto the microgrid only after a closed period: their
 * record was created after the period was closed, and every primary meter
 * link starts after its last day (or there is none).
 *
 * The cutoff is the close, not the period's end, so the section keeps every
 * tenant the close itself counted: fn_billing_period_close_review lists
 * every tenant of the microgrid with no bill, whenever recorded, the person
 * closing acknowledges them (tenants_without_bills), and the close records
 * them as unresolved. A tenant recorded after the period ended but before
 * it closed stays listed. If the close review comes to leave out tenants by
 * date, use its rule here. A period with no closed_at falls back to its last
 * day in its time zone.
 *
 * A link with no start date, or a time that cannot be read or placed in the
 * zone, counts as within the period, so the tenant is kept.
 */
export function joinedAfterPeriod(
  tenant: NotBilledTenant,
  period: Pick<NotBilledPeriod, "end_date" | "timezone" | "closed_at">,
): boolean {
  if (!recordedAfter(tenant.created_at, period)) return false;
  return tenant.primaryLinks.every((l) => typeof l.effective_from === "string" && l.effective_from > period.end_date);
}

/** Whether a record created at `createdAt` was created after the period closed, or after its last day if it has no closed_at. */
function recordedAfter(createdAt: string, period: Pick<NotBilledPeriod, "end_date" | "timezone" | "closed_at">): boolean {
  if (period.closed_at !== null) {
    const created = Date.parse(createdAt);
    const closed = Date.parse(period.closed_at);
    return !Number.isNaN(created) && !Number.isNaN(closed) && created > closed;
  }
  try {
    return dayKeyInZone(new Date(createdAt), period.timezone) > period.end_date;
  } catch {
    return false;
  }
}

/**
 * The tenants the section lists, in the order given: those with no bill for
 * the period, less, in a closed period, those who joined after it closed.
 * The loader counts these against the most a view lists.
 */
export function notBilledTenants<T extends NotBilledTenant>(
  tenants: readonly T[],
  billedTenantIds: ReadonlySet<string>,
  period: NotBilledPeriod,
): T[] {
  return tenants.filter((t) => !billedTenantIds.has(t.id) && !(period.status === "closed" && joinedAfterPeriod(t, period)));
}

export type NotBilledInput = {
  microgridId: string;
  period: NotBilledPeriod;
  /** Every tenant of the microgrid, in the order to list them (by name). */
  tenants: readonly NotBilledTenant[];
  /** The tenants with a bill for the period. */
  billedTenantIds: ReadonlySet<string>;
  fmt: Fmt;
};

type Row = LoadedModel<"collection">["body"]["rows"][number];

export function buildNotBilledModel(i: NotBilledInput): LoadedModel<"collection"> {
  const { microgridId, period, fmt } = i;
  const rows: Row[] = notBilledTenants(i.tenants, i.billedTenantIds, period)
    .map((t) => {
      // As the host links a tenant (src/lib/gui/host/server/entities.ts), and as the review's rows link theirs.
      const tenantRef = { kind: "tenant", id: t.id, label: t.display_name, href: `/microgrids/${microgridId}/setup/tenants/${t.id}` } as const;
      // On a draft only, as the route refuses a closed period.
      const actions: ActionLink[] =
        period.status === "draft"
          ? [{ action: BILL_FROM_READINGS_ACTION.id, params: { periodId: period.id, tenantId: t.id }, label: BILL_FROM_READINGS_ACTION.title }]
          : [];
      return {
        id: t.id,
        entity: tenantRef,
        cells: {
          tenant: fmt.ref(tenantRef),
          reason: fmt.text(notBilledReason(period.status, meterCoverage(t.primaryLinks, period))),
        },
        actions,
      };
    });

  return {
    title: NOT_BILLED_TITLE,
    subtitle: NOT_BILLED_COPY.subtitle,
    actions: [],
    body: {
      columns: [
        { key: "tenant", label: "Tenant", type: "ref", priority: 1 },
        { key: "reason", label: "Why", type: "text", priority: 1 },
      ],
      rows,
      empty: { title: i.tenants.length === 0 ? NOT_BILLED_COPY.noTenants : NOT_BILLED_COPY.allBilled },
    },
  };
}
