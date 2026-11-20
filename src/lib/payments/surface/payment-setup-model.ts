/**
 * payment-setup-model.ts — a community's online payment readiness, and the
 * way to its Payment page, as a `record` view model
 * (`payments.payment-setup`), a section of billing's send queue.
 *
 * Pure: no server-only import, no clock, no I/O. Every string a renderer
 * shows is built here.
 *
 * It replaced the legacy period page's banner shown when online payments
 * were not set up (parity.ts's payment-setup row): a super admin gets the link to the community's
 * Payment page, anyone else is told to ask one, as the banner and the send
 * queue's note decide (SEND_QUEUE_COPY in
 * src/lib/billing/surface/send-queue-model.ts); if either comes to advise
 * by another rule, revisit `nextStep`. Turning payments on is advised to
 * every role, since fn_mgm_set_plugin_enabled lets anyone with access to
 * the organization do it.
 *
 * Nothing of the merchant account enters the model: not its key, its
 * account, nor its last connection test's message, which may hold a
 * provider's response. Each state is fixed copy.
 */
import type { LinkRef } from "@/lib/gui/contract";
import type { Fmt, LoadedModel } from "@/lib/gui/surface";
import type { PaymentReadiness } from "../repository";

export const PAYMENT_SETUP_VIEW = "payments.payment-setup";
/** The LinkRef to the community's Payment page (parity.ts, payment-setup). */
export const COMMUNITY_PAYMENT_LINK = "payments.community-payment";

/** Every field key the view emits. */
export const PAYMENT_SETUP_KEYS = ["status", "next"] as const;

/**
 * The capability's readiness states (getReadiness in ../capability.ts), and
 * "unchecked", a readiness that could not be read: never "disabled", since
 * nobody said payments are off. If getReadiness gains or renames a state,
 * revisit PAYMENT_SETUP_COPY and paymentReadiness in src/lib/gui/status-maps.ts.
 */
export type SetupReadiness = PaymentReadiness["state"] | "unchecked";
export const SETUP_READINESS: readonly SetupReadiness[] = ["ready", "sandbox", "disabled", "unconfigured", "connection_error", "unchecked"];

export const PAYMENT_SETUP_COPY = {
  title: "Payment setup",
  statusLabel: "Online payments",
  nextLabel: "What to do",
  linkLabel: "Community Payment page",
  ready: "Nothing to do: payment links use the community's live account.",
  sandbox: "Payment links use a sandbox account, so payments made through them are tests.",
  sandboxFix: "Switch to a live account on the community's Payment page.",
  sandboxAsk: "Ask a super admin to switch Payment for this community to a live account.",
  disabled: "Online payments are turned off for this organization. Turn on Payments and Pesapal in Settings → Plugins.",
  unconfigured: "No payment provider is configured for this community.",
  unconfiguredFix: "Connect one on the community's Payment page.",
  connectionError: "The community's payment account cannot take payments: it is disabled, missing, or failed its last connection test.",
  connectionErrorFix: "Reconfigure it on the community's Payment page.",
  /** The legacy banner's advice to anyone but a super admin. */
  ask: "Ask a super admin to configure Payment for this community.",
  unchecked: "Could not check online payments right now. Try again shortly.",
} as const;

/** The community's Payment page, payments' own page (/communities/[id]/payment). */
export const communityPaymentHref = (communityId: string): `/${string}` => `/communities/${communityId}/payment`;

/** The view's own page, under the period whose send queue it is a section of. */
export const paymentSetupHref = (microgridId: string, periodId: string): `/${string}` =>
  `/microgrids/${microgridId}/billing/${periodId}/payment-setup`;

/** What the person should do about `readiness`; the fix of a missing or broken account depends on the role. */
export function nextStep(readiness: SetupReadiness, superAdmin: boolean): string {
  const c = PAYMENT_SETUP_COPY;
  switch (readiness) {
    case "ready":
      return c.ready;
    case "sandbox":
      return `${c.sandbox} ${superAdmin ? c.sandboxFix : c.sandboxAsk}`;
    case "disabled":
      return c.disabled;
    case "unconfigured":
      return `${c.unconfigured} ${superAdmin ? c.unconfiguredFix : c.ask}`;
    case "connection_error":
      return `${c.connectionError} ${superAdmin ? c.connectionErrorFix : c.ask}`;
    case "unchecked":
      return c.unchecked;
  }
}

export type PaymentSetupInput = {
  /** The community of the microgrid, which the host resolved for the person's organization. */
  communityId: string;
  readiness: SetupReadiness;
  /** A super admin gets the link to the community's Payment page; anyone else is told to ask one. */
  superAdmin: boolean;
  fmt: Fmt;
};

export function buildPaymentSetupModel(i: PaymentSetupInput): LoadedModel<"record"> {
  const c = PAYMENT_SETUP_COPY;
  const links: LinkRef[] = i.superAdmin ? [{ id: COMMUNITY_PAYMENT_LINK, label: c.linkLabel, href: communityPaymentHref(i.communityId) }] : [];
  return {
    title: c.title,
    actions: [],
    body: {
      sections: [
        {
          fields: [
            { key: "status", label: c.statusLabel, value: i.fmt.status("paymentReadiness", i.readiness) },
            { key: "next", label: c.nextLabel, value: i.fmt.text(nextStep(i.readiness, i.superAdmin)) },
          ],
        },
      ],
    },
    links,
  };
}
