import { afterEach, describe, expect, it, vi } from "vitest";
import type { Href, LinkRef } from "../../../contract";
import { openLink } from "../open";

const link = (href: string, extra: Partial<LinkRef> = {}): LinkRef =>
  ({ id: "billing.pdf", label: "Bill", href, ...extra }) as LinkRef;

const realLocation = window.location;

/** Replaces window.location with one whose href setter records instead of leaving. */
function stubLocation() {
  const set = vi.fn();
  const location = { ...realLocation, origin: realLocation.origin };
  Object.defineProperty(location, "href", { configurable: true, get: () => realLocation.href, set });
  Object.defineProperty(window, "location", { configurable: true, value: location });
  return set;
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
});

describe("openLink", () => {
  it("navigates to a page on this site", async () => {
    const navigate = vi.fn();
    await openLink(link("/microgrids"), navigate);
    expect(navigate).toHaveBeenCalledWith("/microgrids");
  });

  it.each(["//evil.example/x", "/\\evil.example", "javascript:alert(1)", "https://evil.example", "https://wa.me.evil/1"])(
    "opens nothing for %s",
    async (href) => {
      const navigate = vi.fn();
      const opened = vi.spyOn(window, "open").mockImplementation(() => null);
      await openLink(link(href), navigate);
      expect(navigate).not.toHaveBeenCalled();
      expect(opened).not.toHaveBeenCalled();
    },
  );

  it.each(["javascript:alert(1)", "data:text/html,x", "tel:123", "sms:+1?body=<x>"])(
    "never assigns %s to location",
    async (href) => {
      const set = stubLocation();
      await openLink(link(href), vi.fn());
      expect(set).not.toHaveBeenCalled();
    },
  );

  it.each(["tel:+256700000000", "sms:+256700000000?body=hi"])("opens %s through location", async (href) => {
    const set = stubLocation();
    await openLink(link(href), vi.fn());
    expect(set).toHaveBeenCalledWith(href);
  });

  it("downloads through an anchor with the given filename", async () => {
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href") ?? "", download: this.download });
    });
    const navigate = vi.fn();
    await openLink(link("/api/bills/1/pdf", { download: { mime: "application/pdf", filename: "bill.pdf" } }), navigate);
    expect(clicked).toEqual([{ href: "/api/bills/1/pdf", download: "bill.pdf" }]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens WhatsApp in a new tab without an opener", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    await openLink(link("https://wa.me/256700000000"), vi.fn());
    expect(opened).toHaveBeenCalledWith("https://wa.me/256700000000", "_blank", "noopener,noreferrer");
  });

  it("shares through the device when it can, as an absolute URL", async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    const navigate = vi.fn<(href: Href) => void>();
    await openLink(link("/microgrids/a", { share: { title: "Site", text: "Look" } }), navigate);
    expect(share).toHaveBeenCalledWith({ title: "Site", text: "Look", url: `${window.location.origin}/microgrids/a` });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens the link when sharing fails for a reason other than cancelling", async () => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        throw new DOMException("no", "NotAllowedError");
      },
    });
    const navigate = vi.fn();
    await openLink(link("/microgrids/a", { share: { title: "Site", text: "Look" } }), navigate);
    expect(navigate).toHaveBeenCalledWith("/microgrids/a");
  });

  it("opens nothing when the person closes the share sheet", async () => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => {
        throw new DOMException("closed", "AbortError");
      },
    });
    const navigate = vi.fn();
    await openLink(link("/microgrids/a", { share: { title: "Site", text: "Look" } }), navigate);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shares a download as a file when the device can", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("%PDF"));
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    const navigate = vi.fn();
    await openLink(
      link("/api/bills/1/pdf", {
        share: { title: "Bill", text: "Your bill" },
        download: { mime: "application/pdf", filename: "bill.pdf" },
      }),
      navigate,
    );
    expect(share).toHaveBeenCalledWith({ title: "Bill", text: "Your bill", files: [expect.any(File)] });
    const [{ files }] = share.mock.calls[0] as unknown as [{ files: File[] }];
    expect(files[0].name).toBe("bill.pdf");
    expect(navigate).not.toHaveBeenCalled();
  });
});
