"use client";

/**
 * Opens a LinkRef. The href is checked again here, in the browser, whatever
 * the server already checked: only a page on this site, or one of the
 * contract's outside targets (WhatsApp, a call, an SMS), is ever opened.
 */
import type { Href, LinkRef } from "../../contract";
import { isHref, isOutHref } from "../shared/href";

function clickDownload(href: Href, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Shares through the device when it can; false when the link should open instead. */
async function share(link: LinkRef & { href: Href }): Promise<boolean> {
  if (!link.share || typeof navigator.share !== "function") return false;
  const { title, text } = link.share;
  try {
    if (link.download && typeof navigator.canShare === "function") {
      const response = await fetch(link.href, { cache: "no-store" });
      if (response.ok) {
        const files = [new File([await response.blob()], link.download.filename, { type: link.download.mime })];
        if (navigator.canShare({ files })) {
          await navigator.share({ title, text, files });
          return true;
        }
      }
    }
    await navigator.share({ title, text, url: new URL(link.href, window.location.origin).href });
    return true;
  } catch (error) {
    // The person closed the share sheet: done. Anything else falls back to opening.
    return error instanceof DOMException && error.name === "AbortError";
  }
}

/** `navigate` performs a soft navigation for a plain page link. */
export async function openLink(link: LinkRef, navigate: (href: Href) => void): Promise<void> {
  const { href } = link;
  if (isHref(href)) {
    if (await share({ ...link, href })) return;
    if (link.download) clickDownload(href, link.download.filename);
    else navigate(href);
    return;
  }
  if (!isOutHref(href)) return;
  if (href.startsWith("https://")) window.open(href, "_blank", "noopener,noreferrer");
  else window.location.href = href;
}
