/**
 * send-queue-model.ts — one billing period's bills with the payment link a
 * manager sends each tenant, as a `collection` view model
 * (`billing.send-queue`).
 *
 * Pure: no server-only import, no clock, no I/O. Every string a renderer
 * shows is built here.
 *
 * A bill's payment link is stable (PaymentsCapability.stablePaymentLink,
 * src/lib/payments/capability.ts): it is the same URL for the bill's whole
 * life, and opening it starts or reuses a checkout for the bill's current
 * revision. Handing it out writes nothing and contacts no provider, so the
 * queue shows every link there is, ready to copy, where the legacy row menu
 * made a person ask for each one (Generate, Regenerate, and Retry after a
 * failure). It is a bearer link: whoever holds it can start a checkout for
 * the bill, which is why the view is never read by an assistant
 * (../surface.ts).
 *
 * The link is the row's `link` cell, as text a person can select, and the
 * `billing.send-queue@1` ext (./send-queue-ext.ts) carries it again for a
 * renderer that offers to copy it, with the note on readiness in full and
 * the line that says nothing is sent from the page.
 *
 * Nothing on this view sends anything: the manager copies each link and
 * shares it, so the view is titled for its links and says so at the top
 * (SEND_QUEUE_COPY.intro). The view id and its path (…/send) keep the name
 * they were released under. If the view comes to send a link itself, revisit
 * the title, the intro and the period review's link to it.
 *
 * Tenants' email addresses and phone numbers never enter the model: the
 * loader passes only whether a tenant has one.
 */
import type { LinkRef, Value } from "@/lib/gui/contract";
import type { Fmt, LoadedModel } from "@/lib/gui/surface";
import type { PaymentStatus } from "@/lib/payments/state";
import { periodName } from "../close";
import { BACK_TO_PERIOD_LINK, periodHistoryHref } from "./period-history-model";
import { periodLabel } from "./period-label";
import { downloadBillLink, VIEW_HISTORY_LINK } from "./period-review-model";
import type { SendQueueExtData } from "./send-queue-ext";

/** Every cell key the view emits. */
export const SEND_QUEUE_KEYS = ["tenant", "total", "payment", "link", "note"] as const;

/** The ext this model carries; its shape is SendQueueExt in ./send-queue-ext.ts. */
export const SEND_QUEUE_EXT_SCHEMA = "billing.send-queue@1" as const;

/**
 * Whether the period's payment links can be handed out, from the Payments
 * capability's getReadiness (src/lib/payments/capability.ts) for the
 * microgrid's community: "ready", "sandbox", "disabled", "unconfigured" and
 * "connection_error" are its states, and if it gains or renames one, revisit
 * this type and readinessNote. One state may cover several causes:
 * "connection_error" is an account that is disabled, an override pointing at
 * an account that is missing or in another organization, or an account that
 * failed its last connection test, so its note names all three; if
 * getReadiness sorts those into separate states, or adds a cause to one,
 * revisit SEND_QUEUE_COPY.
 *
 * The rest are the loader's. "unchecked" is a readiness that could not be
 * read, getReadiness's refusal when it cannot read a plugin's state
 * included (never "disabled": nobody said payments are off); its copy says
 * to try again rather than whom to ask, since nothing needs configuring.
 * "not_needed" is a period with no bills, where readiness is not read
 * because there is nothing to send, so nothing is said about it; and
 * "no_address" an installation with no public address (MGM_APP_URL) to
 * build links from.
 */
export type SendReadiness =
  | "ready"
  | "sandbox"
  | "disabled"
  | "unconfigured"
  | "connection_error"
  | "unchecked"
  | "not_needed"
  | "no_address";

/** The fixed notes, per bill and on readiness. */
export const SEND_QUEUE_COPY = {
  /** The line at the top of the page: the view only lists links. */
  intro: "Nothing is sent from this page. Copy each bill's link and share it with its tenant yourself.",
  paid: "Paid: no link to send.",
  refunded: "Refunded: no link to send.",
  zero: "Nothing to collect.",
  noContact: "No email or phone for this tenant, so checkout would refuse. Add one on the tenant's page.",
  sandbox: "Payment links use a sandbox account: payments made through them are tests.",
  disabled: "Online payments are turned off for this organization, so there are no links to send.",
  unconfigured: "No payment provider is configured.",
  connectionError:
    "The community's payment account cannot take payments: it is disabled, missing, or failed its last connection test. There are no links to send.",
  /** The legacy banner's advice to a super admin, who can connect a provider; its link is payments' page (parity.ts, payment-setup). */
  superAdminFix: "Connect a payment provider on the community's Payment page to send payment links.",
  /** The legacy banner's advice to anyone else. */
  askSuperAdmin: "Ask a super admin to configure Payment for this community.",
  unchecked: "Could not check online payments right now, so no links are shown. Try again shortly.",
  noAddress: "Payment links cannot be made: this installation has no public address set. Ask your operator.",
} as const;

/** Readiness states with nothing to say: the subtitle is the period's time zone, and there is no note. */
const SILENT_READINESS = ["ready", "not_needed"] as const satisfies readonly SendReadiness[];
type SilentReadiness = (typeof SILENT_READINESS)[number];
const isSilent = (r: SendReadiness): r is SilentReadiness => (SILENT_READINESS as readonly SendReadiness[]).includes(r);

/** The subtitle beside each readiness: short, since a GUI may show a subtitle on one line. Ready and not needed show the period's time zone. */
export const SEND_QUEUE_SUBTITLES: Readonly<Record<Exclude<SendReadiness, SilentReadiness>, string>> = {
  sandbox: "Sandbox payment links",
  disabled: "Online payments are off",
  unconfigured: "No payment provider",
  connection_error: "Payment account not connected",
  unchecked: "Online payments not checked",
  no_address: "No address for payment links",
};

export type SendTenant = {
  id: string;
  display_name: string;
  /** The tenant has a primary email or phone. The address and number themselves never reach the model. */
  hasContact: boolean;
};

export type SendBill = {
  id: string;
  tenant_id: string;
  total_amount: number;
  payment_status: PaymentStatus;
  invoice_number: string | null;
};

export type SendQueueInput = {
  microgrid: { id: string; name: string; currency: string };
  period: { id: string; start_date: string; end_date: string; status: "draft" | "closed"; timezone: string | null };
  /** Every tenant of the microgrid the person can read, in display_name order. */
  tenants: readonly SendTenant[];
  bills: readonly SendBill[];
  readiness: SendReadiness;
  /** A bill's absolute payment link; called only while readiness is ready or sandbox. */
  linkFor(billId: string): string;
  /** For the copy only: a super admin is told to connect a provider, anyone else to ask one. */
  superAdmin: boolean;
  fmt: Fmt;
};

type Row = LoadedModel<"collection">["body"]["rows"][number];
type Column = LoadedModel<"collection">["body"]["columns"][number];

/** Whether links are handed out at all: readiness ready or sandbox, as the invoice PDF and the legacy period page decide. */
export const linksOffered = (readiness: SendReadiness): boolean => readiness === "ready" || readiness === "sandbox";

/**
 * Why a bill has no link to send, or null when it has one. Paid and refunded
 * bills have none, as the legacy row menu offers none. A total of zero or
 * less and a tenant with neither email nor phone mirror what checkout
 * refuses (ensureCheckout in src/lib/payments/capability.ts, which tests
 * the contact as present or not, without trimming): the link would only
 * lead the tenant to that refusal. If ensureCheckout stops refusing these,
 * or refuses something else a bill's own fields show, revisit.
 *
 * Not mirrored: ensureCheckout's refusals that read the bill's payment
 * attempts (one needing reconciliation, isBlockedForNewCheckout, or a
 * receipt already recorded), so such a bill still gets a link that ends in
 * a 409. The attempts are payments' records; the only read of them a
 * billing loader may call is listHistory (LOADER_READS in
 * gui-surface.test.ts), one bill at a time with several queries each, on
 * every 30-second refresh. #201's "Contribute a bill's payment attempts"
 * owns them, and can give the queue a read of which bills checkout would
 * refuse, or attach its view; once it does, mirror them here.
 */
export function billNote(bill: SendBill, tenant: SendTenant): string | null {
  if (bill.payment_status === "paid") return SEND_QUEUE_COPY.paid;
  if (bill.payment_status === "refunded") return SEND_QUEUE_COPY.refunded;
  if (!Number.isFinite(Number(bill.total_amount)) || Number(bill.total_amount) <= 0) return SEND_QUEUE_COPY.zero;
  if (!tenant.hasContact) return SEND_QUEUE_COPY.noContact;
  return null;
}

/** The note on readiness, in full: null when ready or not needed; the advice on a missing or broken provider depends on the role. */
export function readinessNote(readiness: SendReadiness, superAdmin: boolean): SendQueueExtData["note"] {
  const fix = superAdmin ? SEND_QUEUE_COPY.superAdminFix : SEND_QUEUE_COPY.askSuperAdmin;
  switch (readiness) {
    case "ready":
    case "not_needed":
      return null;
    case "sandbox":
      return { tone: "info", text: SEND_QUEUE_COPY.sandbox };
    case "disabled":
      return { tone: "warning", text: SEND_QUEUE_COPY.disabled };
    case "unconfigured":
      return { tone: "warning", text: `${SEND_QUEUE_COPY.unconfigured} ${fix}` };
    case "connection_error":
      return { tone: "warning", text: `${SEND_QUEUE_COPY.connectionError} ${fix}` };
    case "unchecked":
      return { tone: "warning", text: SEND_QUEUE_COPY.unchecked };
    case "no_address":
      return { tone: "warning", text: SEND_QUEUE_COPY.noAddress };
  }
}

/** The view's title: the period's links, never a promise to send them. */
export const sendQueueTitle = (period: string) => `${period} payment links`;

export function buildSendQueueModel(i: SendQueueInput): LoadedModel<"collection"> {
  const { microgrid, period, fmt } = i;
  const label = periodLabel(fmt, period.start_date, period.end_date);
  const offered = linksOffered(i.readiness);

  const columns: Column[] = [
    { key: "tenant", label: "Tenant", type: "ref", priority: 1 },
    { key: "total", label: "Total", type: "money", priority: 1 },
    { key: "payment", label: "Payment", type: "status", priority: 1 },
    { key: "link", label: "Payment link", type: "text", priority: 1 },
    { key: "note", label: "Note", type: "text", priority: 2 },
  ];

  const billByTenant = new Map(i.bills.map((b) => [b.tenant_id, b]));
  const urls: (string | null)[] = [];
  const rows: Row[] = i.tenants.flatMap((tenant): Row[] => {
    const bill = billByTenant.get(tenant.id);
    if (!bill) return [];
    // As the host links a tenant (src/lib/gui/host/server/entities.ts), and as the period review does.
    const tenantRef = { kind: "tenant", id: tenant.id, label: tenant.display_name, href: `/microgrids/${microgrid.id}/setup/tenants/${tenant.id}` } as const;
    const note = billNote(bill, tenant);
    const url = offered && note === null ? i.linkFor(bill.id) : null;
    urls.push(url);
    const cells: Record<string, Value> = {
      tenant: fmt.ref(tenantRef),
      total: fmt.money(Number(bill.total_amount), microgrid.currency),
      payment: fmt.status("billingLineItemPaymentStatus", bill.payment_status),
      link: url === null ? fmt.empty() : fmt.text(url),
      note: note === null ? fmt.empty() : fmt.text(note),
    };
    return [
      {
        id: bill.id,
        entity: { kind: "lineItem", id: bill.id, label: tenant.display_name },
        related: [tenantRef],
        cells,
        actions: [],
        links: [downloadBillLink(bill)],
      },
    ];
  });

  const links: LinkRef[] = [
    { id: BACK_TO_PERIOD_LINK, label: "Back to period", href: `/microgrids/${microgrid.id}/billing/${period.id}` },
    { id: VIEW_HISTORY_LINK, label: "View history", href: periodHistoryHref(microgrid.id, period.id) },
  ];

  const empty: LoadedModel<"collection">["body"]["empty"] =
    i.tenants.length === 0
      ? { title: "No tenants configured for this microgrid." }
      : { title: "No bills yet.", text: "Generate this period's bills on the period page first." };

  const ext: SendQueueExtData = {
    intro: SEND_QUEUE_COPY.intro,
    rows: rows.map((row, n) => ({ id: row.id, url: urls[n] })),
    note: readinessNote(i.readiness, i.superAdmin),
  };

  const subtitle = isSilent(i.readiness) ? period.timezone : SEND_QUEUE_SUBTITLES[i.readiness];
  return {
    title: sendQueueTitle(periodName(period.start_date, period.end_date) ?? label),
    ...(subtitle ? { subtitle } : {}),
    entity: { kind: "billingPeriod", id: period.id, label },
    actions: [],
    links,
    body: { columns, rows, empty },
    ext: { schema: SEND_QUEUE_EXT_SCHEMA, data: ext },
  };
}
