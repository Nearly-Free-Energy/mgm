/**
 * The page a person sees after following a link to something the installed
 * MGM release does not include. Nothing from the request is shown: the path
 * they followed is not echoed back.
 */
import type { NextResponse } from "next/server";
import { PUBLIC_COPY, pickPublicLanguage, type PublicLanguage } from "./copy";
import { publicHtmlResponse, renderPublicPage } from "./page";

export function renderNotReleasedPage(lang: PublicLanguage): string {
  const copy = PUBLIC_COPY[lang].notReleased;
  return renderPublicPage({
    lang,
    title: copy.heading,
    heading: copy.heading,
    paragraphs: [copy.body],
    // `/` is the dashboard when signed in; src/middleware.ts sends a
    // signed-out visitor from it to /login. If `/` stops being a page
    // anyone can be sent to, change this link.
    actions: [{ href: "/", label: copy.startPage }],
  });
}

/** A 404 with the page, in the language the request's Accept-Language picks. */
export function notReleasedResponse(acceptLanguage: string | null): NextResponse {
  const lang = pickPublicLanguage(acceptLanguage);
  return publicHtmlResponse(404, renderNotReleasedPage(lang), {
    "Content-Language": lang,
    Vary: "Accept-Language",
  });
}
