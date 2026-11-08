/**
 * Every word a person reads on the pages built with this folder's frame, by
 * language, so a translator works in this one file. A language is added by
 * listing it in PUBLIC_LANGUAGES and giving it a full PublicCopy: TypeScript
 * refuses an entry with a string missing. Copy shown on a payment page is
 * added only after a fluent reader has checked it.
 */
import { pickLanguage } from "@/lib/locale";

/** BCP 47 tags, in order of preference; the first is the fallback. */
export const PUBLIC_LANGUAGES = ["en"] as const;

export type PublicLanguage = (typeof PUBLIC_LANGUAGES)[number];

export interface PublicCopy {
  /** The product's name, at the foot of every page. */
  productName: string;
  /** A link pointed at a page the installed release does not include. */
  notReleased: {
    heading: string;
    body: string;
    startPage: string;
  };
  /** A bill's payment link that cannot take the household to checkout. */
  paymentLink: {
    /** The link is not one MGM could have written. */
    invalidLink: PublicNotice;
    /** No bill has this link. */
    billNotFound: PublicNotice;
    /** Online payment is switched off or has no account to pay into. */
    onlinePaymentOff: PublicNotice;
    /** Online payment is on, but this bill cannot start a checkout now. */
    checkoutRefused: PublicNotice;
    /** Payments could not be loaded for the bill's organization. */
    paymentUnavailable: PublicNotice;
    /** Checkout reported that the community has no payment provider set. */
    notConfigured: PublicNotice;
    /** The checkout could not be fetched from the payment provider. */
    linkUnavailable: PublicNotice;
    /** The short link could not be looked up. */
    lookupFailed: PublicNotice;
    /**
     * Too many payment links were opened from one network address; the body
     * has the wait. It speaks of the network, not of this household's link,
     * because the pay route's limit is keyed by the client's IP address and
     * many phones on mobile data share one. If that key changes, revisit it.
     */
    tooManyTries: {
      heading: string;
      /**
       * By plural form of the wait (Intl.PluralRules), each with
       * `{seconds}` where the number goes; `other` is the fallback.
       */
      body: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
      tryAgain: string;
    };
  };
  /**
   * The page a household returns to after a hosted checkout. "Checked"
   * covers a failed payment too, so no string here may say the bill is
   * paid. `{name}` is the operator's name and `{number}` their WhatsApp
   * number as they stored it.
   */
  receipt: {
    checkedHeading: string;
    checked: string;
    pendingHeading: string;
    pending: string;
    whatsappPrompt: string;
    whatsappButton: string;
  };
}

/** A heading and the one sentence under it. */
export interface PublicNotice {
  heading: string;
  body: string;
}

export const PUBLIC_COPY = {
  en: {
    productName: "Microgrid Manager",
    notReleased: {
      heading: "Not available in this release",
      body: "This page is not part of the MGM release installed here.",
      startPage: "Go to the start page",
    },
    paymentLink: {
      invalidLink: {
        heading: "Invalid request",
        body: "The link you used isn't valid. Please contact your operator.",
      },
      billNotFound: {
        heading: "Bill not found",
        body: "This bill is not available. Please contact your operator.",
      },
      onlinePaymentOff: {
        heading: "Online payment isn't available",
        body: "You can't pay this bill online right now. Pay your operator the usual way, or contact them.",
      },
      checkoutRefused: {
        heading: "Payment unavailable",
        body: "This bill cannot accept another checkout right now. Please contact your operator.",
      },
      paymentUnavailable: {
        heading: "Payment unavailable",
        body: "Please contact your operator.",
      },
      notConfigured: {
        heading: "Online payment unavailable",
        body: "Online payment is not configured for this community. Please contact your operator.",
      },
      linkUnavailable: {
        heading: "Payment link unavailable",
        body: "Payment link could not be retrieved — please contact your operator.",
      },
      lookupFailed: {
        heading: "Unexpected error",
        body: "We couldn't resolve this payment link. Please try again or contact your operator.",
      },
      tooManyTries: {
        heading: "Too many tries",
        body: {
          one: "Too many payment links were opened from your network. Wait {seconds} second, then try again.",
          other: "Too many payment links were opened from your network. Wait {seconds} seconds, then try again.",
        },
        tryAgain: "Try again",
      },
    },
    receipt: {
      checkedHeading: "Payment checked",
      checked:
        "Your payment status has been checked. Your operator can confirm the receipt and any outstanding balance.",
      pendingHeading: "Payment not confirmed yet",
      pending: "Payment confirmation is pending. Please contact your operator before trying again.",
      whatsappPrompt: "Questions about this payment? Message {name} on WhatsApp.",
      whatsappButton: "WhatsApp {number}",
    },
  },
} as const satisfies Record<PublicLanguage, PublicCopy>;

/** The language to answer a request in, from its Accept-Language header. */
export function pickPublicLanguage(acceptLanguage: string | null): PublicLanguage {
  return pickLanguage(acceptLanguage, PUBLIC_LANGUAGES);
}
