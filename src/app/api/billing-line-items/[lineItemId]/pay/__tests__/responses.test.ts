/**
 * What a bill's payment link answers, response by response: status,
 * Location, Retry-After, Cache-Control, Content-Type, the order of the id
 * check, the rate limit and the first database read, and the audit lines.
 * Bills already sent to households embed this URL, so none of these may
 * change without a ticket (the route's header). The pages' wording and
 * headers are pinned in the second half.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { PaymentError } from "@/lib/payments";
import { PUBLIC_PAGE_SECURITY_HEADERS } from "@/lib/public-html/page";
import { renderPaymentLinkPage, type PaymentLinkPage } from "@/lib/public-html/payment-link";

const mocks = vi.hoisted(() => ({
  service: vi.fn(),
  compose: vi.fn(),
  resolve: vi.fn(),
  checkout: vi.fn(),
  dispose: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.service }));
vi.mock("@/lib/payments/compose", () => ({ composePaymentsPublic: mocks.compose }));
vi.mock("@/lib/payments/resolve-org", () => ({ resolveOrgForLineItem: mocks.resolve }));
vi.mock("@/lib/rate-limit/in-memory", () => ({ checkRateLimit: mocks.rateLimit }));

import { GET } from "../route";

const ID = "33333333-3333-4333-8333-333333333333";
const PAY_PATH = `/api/billing-line-items/${ID}/pay`;
const CHECKOUT_URL = "https://pay.example/checkout?session=abc";
const HTML = "text/html; charset=utf-8";

function invoke(lineItemId = ID, headers: Record<string, string> = {}) {
  return GET(
    new NextRequest(`https://mgm.test/api/billing-line-items/${lineItemId}/pay`, {
      headers: { "x-forwarded-for": "203.0.113.42", ...headers },
    }),
    { params: Promise.resolve({ lineItemId }) },
  );
}

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

/** The route's audit lines, parsed. */
function auditLines(): Record<string, unknown>[] {
  return info.mock.calls
    .map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((line: Record<string, unknown>) => line.event === "payment.pay_redirect");
}

function errorLines(): Record<string, unknown>[] {
  return warn.mock.calls
    .map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((line: Record<string, unknown>) => line.event === "payment.pay_redirect.error");
}

function refuse(status: number, code: string) {
  mocks.checkout.mockResolvedValue({ ok: false, status, code, message: `internal detail for ${code}` });
}

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.service.mockReturnValue({});
  mocks.rateLimit.mockReturnValue({ ok: true });
  mocks.resolve.mockResolvedValue({ orgId: "org" });
  mocks.dispose.mockResolvedValue(undefined);
  mocks.compose.mockResolvedValue({
    ok: true,
    data: { payments: { ensureCheckout: mocks.checkout }, dispose: mocks.dispose },
  });
  mocks.checkout.mockResolvedValue({ ok: true, data: { redirectUrl: CHECKOUT_URL } });
});

afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
});

describe("the payment link keeps its statuses, headers, redirect and audit lines", () => {
  it("redirects to checkout with 302, the checkout URL and no-store, and nothing else", async () => {
    const res = await invoke();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(CHECKOUT_URL);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect([...res.headers.keys()].sort()).toEqual(["cache-control", "location"]);
    expect(await res.text()).toBe("");
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(auditLines()).toEqual([
      expect.objectContaining({ line_item_id: ID, ip_truncated: "203.0.113.0", outcome: "302" }),
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain(CHECKOUT_URL);
  });

  it("answers 400 to a malformed id before the rate limit and any database read", async () => {
    const res = await invoke("not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe(HTML);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("retry-after")).toBeNull();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(auditLines()).toEqual([expect.objectContaining({ line_item_id: "not-a-uuid", outcome: "400" })]);
  });

  it("limits each address to 10 requests a minute, keyed by the first forwarded hop", async () => {
    await invoke(ID, { "x-forwarded-for": "198.51.100.7, 10.0.0.1" });
    expect(mocks.rateLimit).toHaveBeenCalledWith("198.51.100.7", 10, 60_000);
  });

  it("answers 429 with the limiter's Retry-After and no-store, before any database read", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfter: 42 });
    const res = await invoke();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe(HTML);
    expect(res.headers.get("location")).toBeNull();
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(auditLines()).toEqual([expect.objectContaining({ line_item_id: ID, outcome: "429" })]);
  });

  it("answers 429 with Retry-After 60 when the limiter gives no wait", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false });
    const res = await invoke();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("answers 404 for a bill it cannot find, without an audit line", async () => {
    mocks.resolve.mockResolvedValue(null);
    const res = await invoke();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(HTML);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.compose).not.toHaveBeenCalled();
    expect(auditLines()).toEqual([]);
  });

  it.each([500, 503])("answers the composer's %i when payments cannot be loaded", async (status) => {
    mocks.compose.mockResolvedValue({ ok: false, status, code: "payments_unavailable", message: "detail" });
    const res = await invoke();
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe(HTML);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(auditLines()).toEqual([]);
  });

  it.each([
    [409, "payments_disabled"],
    [409, "pesapal_disabled"],
    [409, "payments_not_configured"],
    [409, "payments_account_disabled"],
    [503, "payments_gate_unavailable"],
    [409, "payments_override_broken"],
    [409, "payments_needs_reconciliation"],
    [409, "payments_confirmation_pending"],
    [503, "payments_confirmation_pending"],
    [409, "payments_already_settled"],
    [409, "payments_checkout_superseded"],
    [400, "payments_missing_contact"],
    [400, "payments_zero_amount"],
    [404, "payments_bill_not_found"],
    [500, "payments_unavailable"],
    [503, "payments_checkout_unavailable"],
  ])("answers %i when checkout refuses with %s, and releases the payments scope", async (status, code) => {
    refuse(status, code);
    const res = await invoke();
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe(HTML);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("retry-after")).toBeNull();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(auditLines()).toEqual([]);
    expect(await res.text()).not.toContain(`internal detail for ${code}`);
  });

  it.each([
    ["PESAPAL_LINE_ITEM_NOT_FOUND", 404],
    ["PAYMENT_NOT_CONFIGURED", 409],
    ["PESAPAL_HTTP_ERROR", 502],
  ])("answers a thrown %s with %i and logs its code, not its message, to the page", async (code, status) => {
    mocks.checkout.mockRejectedValue(new PaymentError(`secret detail ${code}`, code));
    const res = await invoke();
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe(HTML);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(await res.text()).not.toContain("secret detail");
    expect(errorLines()).toEqual([expect.objectContaining({ line_item_id: ID, err_code: code })]);
    expect(auditLines()).toEqual([expect.objectContaining({ line_item_id: ID, outcome: String(status) })]);
  });

  it("answers 502 to any other thrown error", async () => {
    mocks.resolve.mockRejectedValue(new Error("database unavailable"));
    const res = await invoke();
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("database unavailable");
    expect(errorLines()).toEqual([expect.objectContaining({ err_code: "unknown" })]);
    expect(auditLines()).toEqual([expect.objectContaining({ outcome: "502" })]);
  });
});

describe("the payment link's pages", () => {
  /** Each way the link can refuse: the id opened, the setup, the status and the page shown. */
  const REFUSALS: [string, string, () => void, number, PaymentLinkPage][] = [
    ["a malformed id", "not-a-uuid", () => {}, 400, { notice: "invalidLink" }],
    ["an unknown bill", ID, () => mocks.resolve.mockResolvedValue(null), 404, { notice: "billNotFound" }],
    [
      "payments that cannot be loaded",
      ID,
      () => mocks.compose.mockResolvedValue({ ok: false, status: 503, code: "payments_unavailable", message: "x" }),
      503,
      { notice: "paymentUnavailable" },
    ],
    ["payments switched off", ID, () => refuse(409, "payments_disabled"), 409, { notice: "onlinePaymentOff" }],
    ["a pending checkout", ID, () => refuse(409, "payments_confirmation_pending"), 409, { notice: "checkoutRefused" }],
    [
      "a thrown missing bill",
      ID,
      () => mocks.checkout.mockRejectedValue(new PaymentError("x", "PESAPAL_LINE_ITEM_NOT_FOUND")),
      404,
      { notice: "billNotFound" },
    ],
    [
      "a thrown missing provider",
      ID,
      () => mocks.checkout.mockRejectedValue(new PaymentError("x", "PAYMENT_NOT_CONFIGURED")),
      409,
      { notice: "notConfigured" },
    ],
    ["a provider failure", ID, () => mocks.checkout.mockRejectedValue(new Error("x")), 502, { notice: "linkUnavailable" }],
    [
      "too many tries",
      ID,
      () => mocks.rateLimit.mockReturnValue({ ok: false, retryAfter: 42 }),
      429,
      { notice: "tooManyTries", retryAfterSeconds: 42, tryAgainHref: PAY_PATH },
    ],
  ];

  it.each(REFUSALS)(
    "shows %s on the shared page, with its security headers and language",
    async (_case, lineItemId, arrange, status, page) => {
      arrange();
      const res = await invoke(lineItemId, { "accept-language": "lg-UG,en;q=0.5" });
      expect(res.status).toBe(status);
      const body = await res.text();
      expect(body).toBe(renderPaymentLinkPage("en", page));
      expect(body).not.toMatch(/<script|\son[a-z]+=|https?:\/\/|<link|src=/i);
      for (const [name, value] of Object.entries(PUBLIC_PAGE_SECURITY_HEADERS)) {
        expect(res.headers.get(name), name).toBe(value);
      }
      expect(res.headers.get("content-language")).toBe("en");
      expect(res.headers.get("vary")).toBe("Accept-Language");
    },
  );

  const ONLINE_PAYMENT_OFF = ["payments_disabled", "pesapal_disabled", "payments_not_configured", "payments_account_disabled"];

  it("names only refusal codes the Payments capability returns", () => {
    const capability = readFileSync(path.resolve(__dirname, "../../../../../../lib/payments/capability.ts"), "utf8");
    for (const code of ONLINE_PAYMENT_OFF) expect(capability, code).toContain(`"${code}"`);
  });

  it.each(ONLINE_PAYMENT_OFF)(
    "says online payment isn't available and to pay the operator the usual way when checkout refuses with %s",
    async (code) => {
      refuse(409, code);
      const body = await (await invoke()).text();
      expect(body).toContain("<h1>Online payment isn&#39;t available</h1>");
      expect(body).toContain(
        "<p>You can&#39;t pay this bill online right now. Pay your operator the usual way, or contact them.</p>",
      );
      expect(body).not.toContain("another checkout");
    },
  );

  // Every other refusal checkout can return, so the list above cannot grow
  // to take one of these without a test failing.
  it.each([
    [503, "payments_gate_unavailable"],
    [409, "payments_override_broken"],
    [409, "payments_needs_reconciliation"],
    [409, "payments_confirmation_pending"],
    [503, "payments_confirmation_pending"],
    [409, "payments_already_settled"],
    [409, "payments_checkout_superseded"],
    [400, "payments_missing_contact"],
    [400, "payments_zero_amount"],
    [404, "payments_bill_not_found"],
    [500, "payments_unavailable"],
    [503, "payments_checkout_unavailable"],
  ])("keeps the 'cannot accept another checkout' page for %i %s", async (status, code) => {
    refuse(status, code);
    const body = await (await invoke()).text();
    expect(body).toContain("<h1>Payment unavailable</h1>");
    expect(body).toContain("<p>This bill cannot accept another checkout right now. Please contact your operator.</p>");
    expect(body).not.toContain("usual way");
  });

  it("says how many seconds to wait, matching Retry-After, with a Try again link to the same bill", async () => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfter: 42 });
    const res = await invoke();
    const body = await res.text();
    expect(res.headers.get("retry-after")).toBe("42");
    expect(body).toContain("<h1>Too many tries</h1>");
    expect(body).toContain(
      "<p>This payment link was opened too many times in a short time. Wait 42 seconds, then try again.</p>",
    );
    expect(body).toContain(`<a class="btn" href="${PAY_PATH}">Try again</a>`);
  });

  it.each([
    ["a 1-second wait", 1, "Wait 1 second, then try again."],
    ["no wait from the limiter", undefined, "Wait 60 seconds, then try again."],
  ])("words %s as %j", async (_case, retryAfter, sentence) => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfter });
    expect(await (await invoke()).text()).toContain(sentence);
  });
});
