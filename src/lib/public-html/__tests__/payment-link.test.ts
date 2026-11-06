import { describe, expect, it } from "vitest";
import { PUBLIC_COPY } from "../copy";
import { escapeHtml, PUBLIC_PAGE_SECURITY_HEADERS } from "../page";
import {
  paymentLinkResponse,
  renderPaymentLinkPage,
  type PaymentLinkNotice,
} from "../payment-link";

const NOTICES = Object.keys(PUBLIC_COPY.en.paymentLink).filter(
  (key): key is PaymentLinkNotice => key !== "tooManyTries",
);
const PAY_PATH = "/api/billing-line-items/33333333-3333-4333-8333-333333333333/pay";

describe("the pages a payment link shows instead of checkout", () => {
  it.each(NOTICES)("shows the %s notice as the title, heading and one sentence, with no link", (notice) => {
    const { heading, body } = PUBLIC_COPY.en.paymentLink[notice];
    const html = renderPaymentLinkPage("en", { notice });
    expect(html).toContain(`<title>${escapeHtml(heading)}</title>`);
    expect(html).toContain(`<main>\n<h1>${escapeHtml(heading)}</h1>\n<p>${escapeHtml(body)}</p>\n</main>`);
    expect(html).not.toContain("<a ");
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("tells a household with online payment off to pay the operator the usual way", () => {
    const html = renderPaymentLinkPage("en", { notice: "onlinePaymentOff" });
    expect(html).toContain("<h1>Online payment isn&#39;t available</h1>");
    expect(html).toContain("Pay your operator the usual way, or contact them.");
  });

  it.each([
    [1, "Wait 1 second, then try again."],
    [2, "Wait 2 seconds, then try again."],
    [42, "Wait 42 seconds, then try again."],
    [60, "Wait 60 seconds, then try again."],
  ])("says to wait %i seconds and links Try again to the same link", (seconds, sentence) => {
    const html = renderPaymentLinkPage("en", {
      notice: "tooManyTries",
      retryAfterSeconds: seconds,
      tryAgainHref: PAY_PATH,
    });
    expect(html).toContain("<title>Too many tries</title>");
    expect(html).toContain("<h1>Too many tries</h1>");
    expect(html).toContain(`<p>This payment link was opened too many times in a short time. ${sentence}</p>`);
    expect(html).toContain(`<a class="btn" href="${PAY_PATH}">Try again</a>`);
    expect(html).not.toContain("{seconds}");
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("refuses a Try again link that leaves the site", () => {
    expect(() =>
      renderPaymentLinkPage("en", {
        notice: "tooManyTries",
        retryAfterSeconds: 5,
        tryAgainHref: "https://pay.example/checkout",
      }),
    ).toThrow();
  });
});

describe("paymentLinkResponse", () => {
  it("answers the status given with the page, the security headers, its language and Vary", async () => {
    const res = paymentLinkResponse(409, "en-GB,en;q=0.9", { notice: "onlinePaymentOff" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(renderPaymentLinkPage("en", { notice: "onlinePaymentOff" }));
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-language")).toBe("en");
    expect(res.headers.get("vary")).toBe("Accept-Language");
    for (const [name, value] of Object.entries(PUBLIC_PAGE_SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.get("location")).toBeNull();
  });

  it("adds the headers a route passes, such as Retry-After, without letting them replace the page's own", () => {
    const res = paymentLinkResponse(
      429,
      null,
      { notice: "tooManyTries", retryAfterSeconds: 7, tryAgainHref: PAY_PATH },
      { "Retry-After": "7", "Cache-Control": "public, max-age=600", "Content-Type": "text/plain" },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it.each([null, "", "lg-UG", "sw;q=1,fr;q=0.5", '"><script>alert(1)</script>'])(
    "answers in English, with nothing from the request, for Accept-Language %j",
    async (header) => {
      const res = paymentLinkResponse(404, header, { notice: "billNotFound" });
      expect(res.headers.get("content-language")).toBe("en");
      expect(await res.text()).toBe(renderPaymentLinkPage("en", { notice: "billNotFound" }));
    },
  );
});
