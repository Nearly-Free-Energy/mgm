/**
 * The href checks: the string checks a browser can run (../../shared/href.ts)
 * and the server's released-route and ownership checks (../hrefs.ts).
 */
import { describe, expect, it } from "vitest";
import { isHref, isOutHref as isOutHrefShared, isSameOriginPath } from "../../shared/href";
import { isLinkHref, isOutHref, isPageHref, parseHref } from "../hrefs";

const MG = "00000000-0000-4000-8000-0000000000b1";

const OFF_SITE = [
  "//evil.example/x",
  "/\\evil.example",
  "https://evil.example/",
  "javascript:alert(1)",
  "x/y",
  "",
  "/a\u0000b",
  "/a\nb",
  "/a/../b",
  "/a/%2e%2e/b",
  "/a/./b",
  "/a%2fb",
  "/a%5Cb",
  "/a b",
  "/é",
  `/${"a".repeat(2048)}`,
];

describe("isSameOriginPath (shared)", () => {
  it("accepts paths with queries and fragments", () => {
    for (const h of ["/", `/microgrids/${MG}/billing?status=draft`, "/organizations#top", "/a%20b"]) {
      expect(isSameOriginPath(h), h).toBe(true);
      expect(isHref(h), h).toBe(true);
    }
  });

  it("refuses anything that leaves the site or that the URL parser would rewrite", () => {
    for (const h of OFF_SITE) {
      expect(isSameOriginPath(h), JSON.stringify(h)).toBe(false);
      expect(isHref(h), JSON.stringify(h)).toBe(false);
    }
    expect(isHref(42)).toBe(false);
  });
});

describe("isOutHref", () => {
  it("accepts a WhatsApp chat, a call and an SMS", () => {
    for (const h of ["https://wa.me/256700000000", "https://wa.me/256700000000?text=Hello%20there", "tel:+256700000000", "sms:+256700000000?body=Hi"]) {
      expect(isOutHref(h), h).toBe(true);
      expect(isOutHrefShared(h), h).toBe(true);
    }
  });

  it("refuses look-alikes", () => {
    for (const h of [
      "https://wa.me.evil.example/256700000000",
      "https://wa.me/256700000000/x",
      "http://wa.me/256700000000",
      "https://wa.me/12345",
      "tel:256700000000",
      "tel:+2567000000001234567",
      "sms:+256700000000?body=<b>",
      "sms:+256700000000?text=x",
      "/microgrids",
      "javascript:alert(1)//https://wa.me/256700000000",
      "javascript:alert(1)//tel:+256700000000",
      "x sms:+256700000000",
    ]) {
      expect(isOutHref(h), h).toBe(false);
      expect(isOutHrefShared(h), h).toBe(false);
    }
  });
});

describe("parseHref", () => {
  it("splits a same-origin href", () => {
    const parsed = parseHref(`/microgrids/${MG}/billing?status=draft&ui.sel=1`);
    expect(parsed?.path).toBe(`/microgrids/${MG}/billing`);
    expect(parsed?.search.get("status")).toBe("draft");
  });

  it("returns null for anything off-site", () => {
    for (const h of OFF_SITE) expect(parseHref(h), JSON.stringify(h)).toBeNull();
  });
});

describe("isPageHref", () => {
  it("accepts released pages, with a query", () => {
    for (const h of ["/", "/organizations", `/microgrids/${MG}/operations`, `/microgrids/${MG}/billing?status=draft`])
      expect(isPageHref(h), h).toBe(true);
  });

  it("refuses unreleased paths, /api and anything off-site", () => {
    for (const h of [`/microgrids/${MG}/nowhere`, "/api", "/api/billing-periods", "/api/mgm/health", ...OFF_SITE])
      expect(isPageHref(h), JSON.stringify(h)).toBe(false);
  });
});

describe("isLinkHref", () => {
  it("accepts pages, released downloads a plugin owns, and OutHrefs", () => {
    for (const h of [
      `/microgrids/${MG}/billing`,
      `/api/billing-line-items/${MG}/pdf`,
      `/api/billing-periods/${MG}/export-csv`,
      "tel:+256700000000",
    ])
      expect(isLinkHref(h), h).toBe(true);
  });

  it("refuses unreleased or unowned /api paths and other schemes", () => {
    // /api/mgm/health is released but no catalog plugin owns it.
    for (const h of [
      "/api/mgm/health",
      "/api/gui/view",
      "/api/nowhere",
      `/microgrids/${MG}/nowhere`,
      "https://evil.example/x.pdf",
      "mailto:a@b.c",
      ...OFF_SITE,
    ])
      expect(isLinkHref(h), JSON.stringify(h)).toBe(false);
  });
});
