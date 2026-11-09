/**
 * The pages a household sees when a bill's payment link cannot take them to
 * checkout: the `/api/billing-line-items/<id>/pay` link and its short
 * `/p/<slug>` form. The routes choose the status and any extra header, such
 * as Retry-After; this module renders the notice in the request's language
 * and adds the frame's headers, Content-Language and Vary.
 */
import type { NextResponse } from "next/server";
import { PUBLIC_COPY, pickPublicLanguage, type PublicCopy, type PublicLanguage } from "./copy";
import { publicHtmlResponse, renderPublicPage } from "./page";

type Notices = PublicCopy["paymentLink"];

/** A notice that is a heading and one sentence, with nothing to fill in. */
export type PaymentLinkNotice = Exclude<keyof Notices, "tooManyTries">;

export type PaymentLinkPage =
  | { notice: PaymentLinkNotice }
  | {
      notice: "tooManyTries";
      /** Whole seconds, the same number the response sends as Retry-After. */
      retryAfterSeconds: number;
      /** The link the household opened, so Try again opens it once more. */
      tryAgainHref: string;
    };

/**
 * A wait as a whole number of seconds, at least 1, so it is a valid
 * Retry-After and never reads "0 seconds". `fallback` stands in when there
 * is no finite wait.
 */
export function wholeSecondsToWait(seconds: number | undefined, fallback: number): number {
  const wait = seconds !== undefined && Number.isFinite(seconds) ? seconds : fallback;
  return Math.max(1, Math.ceil(wait));
}

export function renderPaymentLinkPage(lang: PublicLanguage, page: PaymentLinkPage): string {
  const copy: Notices = PUBLIC_COPY[lang].paymentLink;
  if (page.notice === "tooManyTries") {
    const { heading, body, tryAgain } = copy.tooManyTries;
    const seconds = wholeSecondsToWait(page.retryAfterSeconds, 1);
    const sentence = body[new Intl.PluralRules(lang).select(seconds)] ?? body.other;
    return renderPublicPage({
      lang,
      title: heading,
      heading,
      paragraphs: [sentence.replace("{seconds}", String(seconds))],
      actions: [{ href: page.tryAgainHref, label: tryAgain }],
    });
  }
  const { heading, body } = copy[page.notice];
  return renderPublicPage({ lang, title: heading, heading, paragraphs: [body] });
}

/**
 * `status` with the page in the language the request's Accept-Language
 * picks. `headers` adds to the page's headers (publicHtmlResponse) and
 * cannot replace them.
 */
export function paymentLinkResponse(
  status: number,
  acceptLanguage: string | null,
  page: PaymentLinkPage,
  headers: Readonly<Record<string, string>> = {},
): NextResponse {
  const lang = pickPublicLanguage(acceptLanguage);
  return publicHtmlResponse(status, renderPaymentLinkPage(lang, page), {
    ...headers,
    "Content-Language": lang,
    Vary: "Accept-Language",
  });
}
