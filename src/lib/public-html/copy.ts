/**
 * Every word a person reads on the pages in this folder, by language, so a
 * translator works in this one file. A language is added by listing it in
 * PUBLIC_LANGUAGES and giving it a full PublicCopy: TypeScript refuses an
 * entry with a string missing. Copy shown on a payment page is added only
 * after a fluent reader has checked it.
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

export const PUBLIC_COPY = {
  en: {
    productName: "Microgrid Manager",
    notReleased: {
      heading: "Not available in this release",
      body: "This page is not part of the MGM release installed here.",
      startPage: "Go to the start page",
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
