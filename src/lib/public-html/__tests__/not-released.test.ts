import { describe, expect, it } from "vitest";
import { notReleasedResponse, renderNotReleasedPage } from "../not-released";
import { PUBLIC_PAGE_SECURITY_HEADERS } from "../page";

describe("the page for a link outside the installed release", () => {
  it("says the page is not part of this release and links to the start page", () => {
    const html = renderNotReleasedPage("en");
    expect(html).toContain("<title>Not available in this release</title>");
    expect(html).toContain("<h1>Not available in this release</h1>");
    expect(html).toContain("<p>This page is not part of the MGM release installed here.</p>");
    expect(html).toContain('<a class="btn" href="/">Go to the start page</a>');
    expect(html).not.toContain('<main class="warning">');
    expect(html).not.toMatch(/<script/i);
  });

  it("answers 404 with the page, its language and the security headers", async () => {
    const res = notReleasedResponse("en-GB,en;q=0.9");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(renderNotReleasedPage("en"));
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-language")).toBe("en");
    expect(res.headers.get("vary")).toBe("Accept-Language");
    for (const [name, value] of Object.entries(PUBLIC_PAGE_SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
  });

  it.each([null, "", "lg-UG", '"><script>alert(1)</script>', "en;q=0"])(
    "answers in English, with nothing from the request, for Accept-Language %j",
    async (header) => {
      const res = notReleasedResponse(header);
      expect(res.headers.get("content-language")).toBe("en");
      expect(await res.text()).toBe(renderNotReleasedPage("en"));
    },
  );

  it("stays under 4 KB", () => {
    expect(Buffer.byteLength(renderNotReleasedPage("en"), "utf8")).toBeLessThanOrEqual(4096);
  });
});
