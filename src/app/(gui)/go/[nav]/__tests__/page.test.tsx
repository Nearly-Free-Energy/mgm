/**
 * /go/<nav>: the session check comes first, then the page sends the person
 * on, answers not found, or lists the places to choose from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  getRequestUserAccess: vi.fn(),
  resolveGoTarget: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("@/lib/auth/request-access", () => ({ getRequestUserAccess: mocks.getRequestUserAccess }));
vi.mock("@/lib/gui/host/server/go", () => ({ resolveGoTarget: mocks.resolveGoTarget }));

import GoPage from "../page";

const params = (nav: string) => ({ params: Promise.resolve({ nav }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRequestUserAccess.mockResolvedValue({ user: { id: "user-1" }, roles: [{ role: "org_manager" }] });
});

describe("/go/<nav>", () => {
  it("sends a signed-out visitor to /login before resolving anything", async () => {
    mocks.getRequestUserAccess.mockResolvedValue({ user: null, roles: [] });
    await expect(GoPage(params("billing.periods"))).rejects.toThrow("redirect:/login");
    expect(mocks.resolveGoTarget).not.toHaveBeenCalled();
  });

  it("answers not found for an entry the person has no link to", async () => {
    mocks.resolveGoTarget.mockResolvedValue({ kind: "not-found" });
    await expect(GoPage(params("billing.nothing"))).rejects.toThrow("not-found");
    expect(mocks.resolveGoTarget).toHaveBeenCalledWith("billing.nothing");
  });

  it("sends the person to the filled link", async () => {
    mocks.resolveGoTarget.mockResolvedValue({ kind: "redirect", href: "/microgrids/mg-1/billing" });
    await expect(GoPage(params("billing.periods"))).rejects.toThrow("redirect:/microgrids/mg-1/billing");
  });

  it("lists the places to choose from, each a link", async () => {
    mocks.resolveGoTarget.mockResolvedValue({
      kind: "choose",
      title: "Billing",
      needs: ["microgrid"],
      choices: [
        { label: "Kasana East", href: "/microgrids/mg-1/billing" },
        { label: "Kasana West", href: "/microgrids/mg-2/billing" },
      ],
    });
    const html = renderToStaticMarkup((await GoPage(params("billing.periods"))) as ReactElement);
    expect(html).toContain("<h1");
    expect(html).toContain("Billing");
    expect(html).toContain("Choose a microgrid to open it in.");
    expect(html).toContain('href="/microgrids/mg-1/billing"');
    expect(html).toContain('href="/microgrids/mg-2/billing"');
    expect(html).toContain("Kasana West");
  });

  it("says there is no place yet and links to the list of them", async () => {
    mocks.resolveGoTarget.mockResolvedValue({
      kind: "none",
      title: "Billing",
      needs: ["microgrid"],
      missing: "microgrid",
      listed: true,
      list: { label: "Microgrids", href: "/microgrids" },
    });
    const html = renderToStaticMarkup((await GoPage(params("billing.periods"))) as ReactElement);
    expect(html).toContain("Add a microgrid first");
    expect(html).toContain("Billing opens in a microgrid, and there is none to open it in yet.");
    // The page's h1 names the entry; the empty state sits under an h2, not a repeat of it.
    expect(html.match(/>Billing</g)).toHaveLength(1);
    expect(html).toMatch(/<h2[^>]*>Where to open it<\/h2>/);
    // The link has no `flex`, so globals.css does not size it: its own classes give the 44 px target.
    const anchor = html.match(/<a [^>]*href="\/microgrids"[^>]*>/)?.[0] ?? "";
    expect(anchor).toContain("pointer-coarse:inline-flex");
    expect(anchor).toContain("pointer-coarse:min-h-11");
  });

  it("says when places exist but none fits the link, without asking for another", async () => {
    mocks.resolveGoTarget.mockResolvedValue({
      kind: "none",
      title: "Billing",
      needs: ["community", "microgrid"],
      missing: null,
      listed: false,
      list: null,
    });
    const html = renderToStaticMarkup((await GoPage(params("billing.periods"))) as ReactElement);
    expect(html).toContain("Open it from the page that leads to it");
    expect(html).toContain("Billing opens in a community and microgrid, and none of yours fits this link.");
    expect(html).not.toContain("first");
    expect(html).not.toContain("<a ");
  });

  it("says when the link cannot choose the place an entry needs", async () => {
    mocks.resolveGoTarget.mockResolvedValue({
      kind: "none",
      title: "Billing period",
      needs: ["microgrid", "billingPeriod"],
      missing: "billingPeriod",
      listed: false,
      list: null,
    });
    const html = renderToStaticMarkup((await GoPage(params("billing.period"))) as ReactElement);
    expect(html).toContain("Open it from the page that leads to it");
    expect(html).toContain("opens in a microgrid and billing period, which this link cannot choose.");
    expect(html).not.toContain("<a ");
  });
});
