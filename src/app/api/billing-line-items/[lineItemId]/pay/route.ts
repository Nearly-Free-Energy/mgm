/**
 * GET /api/billing-line-items/[lineItemId]/pay
 *
 * Public, stable redirect URL embedded in the consumer-facing PDF invoice
 * (#202 / D6). The customer (Aaron's tenant) clicks the link in WhatsApp
 * and lands here; this route 302s them to the cached Pesapal hosted-checkout
 * URL, minting one on first call if necessary.
 *
 * **Legacy / backward-compat note (#223):** As of #223 (2026-05) new PDF
 * bills embed the shorter `/p/<6-8 char slug>` indirection instead of this
 * long URL. The `/p/` route resolves the slug to a line_item_id and 302s
 * here — both paths converge on the same `ensurePaymentLinkForLineItem`
 * pipeline. This route is kept FOREVER for backward compatibility with
 * bills already shipped to customers before the slug change: those PDFs
 * embed the long URL in WhatsApp threads, and we cannot rewrite already-
 * delivered messages. Behavior, status codes, and response shapes here
 * MUST NOT change without an explicit follow-up ticket. New behavior
 * (additional auditing, rate-limit knobs, etc.) is fine; observable
 * semantics on the happy path are not.
 *
 *   - NO session auth (the line-item ID is the access token; UUID v4 entropy
 *     + IP rate-limit defends against scraping).
 *   - Service-role Supabase client (RLS bypassed by design).
 *   - 10 req/min per IP via in-memory sliding window. Per-Vercel-instance,
 *     not cluster-wide; defends against accidental scraping but a coordinated
 *     attacker across instances bypasses it. A future ticket can swap in
 *     Upstash / Vercel KV when abuse signal appears (the call site only
 *     depends on `checkRateLimit(...)`'s contract). Only allowed requests
 *     count toward the window: `checkRateLimit` does not record a refused
 *     one, so pressing Try again on the 429 page cannot lengthen the wait.
 *     A replacement limiter must keep that, or the page's promise breaks;
 *     `src/lib/rate-limit/__tests__/in-memory.test.ts` pins it.
 *
 * Status-code map (RFC 7231-aligned):
 *
 *   | Condition                                              | Status      | Body                                 |
 *   |--------------------------------------------------------|-------------|--------------------------------------|
 *   | Happy path                                             | 302         | Redirect to Pesapal URL              |
 *   | Malformed line-item id                                 | 400         | HTML "isn't valid"                   |
 *   | Rate-limit exceeded                                    | 429         | HTML "Too many tries" + Retry-After  |
 *   | Line item not found (or PESAPAL_LINE_ITEM_NOT_FOUND)   | 404         | HTML "not available"                 |
 *   | Payments cannot be composed for the organization       | as returned | HTML "Please contact your operator"  |
 *   | Online payment off or no account (ONLINE_PAYMENT_OFF)  | 409         | HTML "pay the usual way"             |
 *   | Any other checkout refusal                             | as returned | HTML "cannot accept another checkout"|
 *   | Community has no payment provider (PAYMENT_NOT_CONFIG) | 409         | HTML "not configured"                |
 *   | Any other error (Pesapal upstream / auth / etc)        | 502         | HTML "could not be retrieved"        |
 *
 * The HTML pages come from src/lib/public-html/payment-link.ts, in the
 * language the request's Accept-Language picks, with the frame's security
 * headers, Content-Language and Vary. This file chooses each status and the
 * Retry-After; every response is `Cache-Control: no-store`.
 * `__tests__/responses.test.ts` pins all of it.
 *
 *   "Soft-deleted" is NOT a case — `billing_line_items` has no soft-delete
 *   column (verified at 00001_schema.sql:237-248). Hard-deletes cascade from
 *   `billing_periods.ON DELETE CASCADE` and surface here as 404.
 *
 * Audit logging: the malformed id, the rate limit, the redirect and every
 * thrown error write a structured log line via
 * `scrubSecretValues(payload, { extra: [redirectUrl].filter(Boolean) })` so
 * the persisted Pesapal URL never lands in stdout. The log includes the
 * truncated IP, line_item_id, and outcome (400 / 429 / 302, or the thrown
 * error's 404 / 409 / 502). An unknown bill, payments that cannot be
 * composed and a checkout refusal write no line.
 */

import { NextRequest, NextResponse } from "next/server";

import { PaymentError } from "@/lib/payments";
import { composePaymentsPublic } from "@/lib/payments/compose";
import { resolveOrgForLineItem } from "@/lib/payments/resolve-org";
import { createServiceClient } from "@/lib/supabase/service";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";
import { checkRateLimit } from "@/lib/rate-limit/in-memory";
import {
  paymentLinkResponse,
  wholeSecondsToWait,
  type PaymentLinkNotice,
} from "@/lib/public-html/payment-link";

/**
 * Seconds this function may run. Declared rather than left to the hosting
 * default so the Pesapal client's per-request timeout
 * (`PESAPAL_REQUEST_TIMEOUT_MS`, two requests per checkout) and the window
 * after which an unpayable attempt is superseded
 * (`UNPAYABLE_ATTEMPT_WINDOW_MS`) can be sized against it. Changing it means
 * revisiting both.
 */
export const maxDuration = 30;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RATE_LIMIT_PER_MIN = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Checkout refusals that mean the household cannot pay this bill online at
 * all, so the page tells them to pay their operator the usual way. The codes
 * are the plugin gate's and the merchant-account resolution's in
 * `ensureCheckout` (src/lib/payments/capability.ts); if a code there is
 * renamed or a new "off" state is added, update this list and its copy in
 * `__tests__/responses.test.ts`, which fails when one of these codes no
 * longer appears in capability.ts.
 */
const ONLINE_PAYMENT_OFF: ReadonlySet<string> = new Set([
  "payments_disabled",
  "pesapal_disabled",
  "payments_not_configured",
  "payments_account_disabled",
]);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> },
): Promise<Response> {
  const startedAt = Date.now();
  const { lineItemId } = await params;

  const ipFull = readClientIp(request);
  const acceptLanguage = request.headers.get("accept-language");

  if (!UUID_RE.test(lineItemId)) {
    logPayEvent({
      lineItemId,
      ipTruncated: truncateIp(ipFull),
      outcome: "400",
      durationMs: Date.now() - startedAt,
    });
    return paymentLinkResponse(400, acceptLanguage, { notice: "invalidLink" });
  }

  // ── Rate limit ──────────────────────────────────────────────────────────
  const rl = checkRateLimit(ipFull, RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_MS);
  if (!rl.ok) {
    logPayEvent({
      lineItemId,
      ipTruncated: truncateIp(ipFull),
      outcome: "429",
      durationMs: Date.now() - startedAt,
    });
    // Whole seconds and at least 1, so Retry-After is always a valid
    // positive integer and the page's wait matches it.
    const retryAfter = wholeSecondsToWait(rl.retryAfter, RATE_LIMIT_WINDOW_MS / 1000);
    // The id passed the UUID check above, so this is a path on this site.
    const tryAgainHref = `/api/billing-line-items/${lineItemId}/pay`;
    return paymentLinkResponse(
      429,
      acceptLanguage,
      { notice: "tooManyTries", retryAfterSeconds: retryAfter, tryAgainHref },
      { "Retry-After": String(retryAfter) },
    );
  }

  const supabase = createServiceClient();
  let result;
  try {
    const orgScope = await resolveOrgForLineItem(supabase, lineItemId);
    if (!orgScope) return paymentLinkResponse(404, acceptLanguage, { notice: "billNotFound" });
    const composed = await composePaymentsPublic({ supabase, organizationId: orgScope.orgId });
    if (!composed.ok) return paymentLinkResponse(composed.status, acceptLanguage, { notice: "paymentUnavailable" });
    try {
      const checkout = await composed.data.payments.ensureCheckout(lineItemId);
      if (!checkout.ok) {
        const notice = ONLINE_PAYMENT_OFF.has(checkout.code) ? "onlinePaymentOff" : "checkoutRefused";
        return paymentLinkResponse(checkout.status, acceptLanguage, { notice });
      }
      result = { redirectUrl: checkout.data.redirectUrl };
    } finally { await composed.data.dispose(); }
  } catch (err) {
    return handleError(err, { lineItemId, ipTruncated: truncateIp(ipFull), startedAt, acceptLanguage });
  }

  logPayEvent({
    lineItemId,
    ipTruncated: truncateIp(ipFull),
    outcome: "302",
    durationMs: Date.now() - startedAt,
    redirectUrl: result.redirectUrl,
  });

  // 302 redirect with no-store so the URL never gets cached by intermediate
  // proxies or the browser. Pesapal session URLs are sensitive even in our
  // "stable redirect" model — the *MGM* URL is stable; the *Pesapal* URL it
  // resolves to is one-shot-ish.
  return NextResponse.redirect(result.redirectUrl, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

// ─── error mapping ──────────────────────────────────────────────────────────

function handleError(
  err: unknown,
  ctx: { lineItemId: string; ipTruncated: string; startedAt: number; acceptLanguage: string | null },
): Response {
  const isPaymentErr = err instanceof PaymentError;
  let status = 502;
  let notice: PaymentLinkNotice = "linkUnavailable";

  if (isPaymentErr) {
    if (err.code === "PESAPAL_LINE_ITEM_NOT_FOUND") {
      status = 404;
      notice = "billNotFound";
    } else if (err.code === "PAYMENT_NOT_CONFIGURED") {
      status = 409;
      notice = "notConfigured";
    }
    // Every other PaymentError code falls through to the 502 default
    // ("upstream failed"). We deliberately do NOT surface 403 / 503 / 400
    // mappings used by the operator-facing /url route — public callers get
    // the same opaque "couldn't retrieve" page regardless of the upstream
    // error class. The scrubbed log captures the actual code.
  }

  // Server-side logging — keep error.code visible for operators but never
  // leak the message body to the public response.
  console.warn(
    JSON.stringify({
      event: "payment.pay_redirect.error",
      line_item_id: ctx.lineItemId,
      ip_truncated: ctx.ipTruncated,
      err_code: isPaymentErr ? err.code : "unknown",
      err_message: isPaymentErr ? err.message : "(non-PaymentError)",
      at: new Date().toISOString(),
    }),
  );

  logPayEvent({
    lineItemId: ctx.lineItemId,
    ipTruncated: ctx.ipTruncated,
    outcome: String(status),
    durationMs: Date.now() - ctx.startedAt,
  });

  return paymentLinkResponse(status, ctx.acceptLanguage, { notice });
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Read client IP from headers. Next.js 16's NextRequest does NOT expose `.ip`
 * (verified at node_modules/next/dist/server/web/spec-extension/request.d.ts).
 * Read x-forwarded-for, then x-real-ip, then fall back to the literal
 * 'unknown'.
 */
function readClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    // First comma-separated hop is the client.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

/**
 * Truncate IPv4 to /24 (zero last octet) and IPv6 to /48 for the audit log.
 * The rate-limit key uses the full IP — only the audit log gets the
 * truncated form.
 */
function truncateIp(ip: string): string {
  if (!ip || ip === "unknown") return "unknown";
  // IPv4: a.b.c.d → a.b.c.0
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  // IPv6: keep first 3 hextets (≈ /48) and zero the rest.
  if (ip.includes(":")) {
    // Normalize :: by splitting carefully; we just want a coarse /48 form.
    const parts = ip.split(":");
    const head = parts.slice(0, 3).join(":");
    return `${head}::/48`;
  }
  return ip;
}

function logPayEvent(args: {
  lineItemId: string;
  ipTruncated: string;
  outcome: string;
  durationMs: number;
  redirectUrl?: string;
}): void {
  const payload = {
    event: "payment.pay_redirect",
    line_item_id: args.lineItemId,
    ip_truncated: args.ipTruncated,
    outcome: args.outcome,
    duration_ms: args.durationMs,
    at: new Date().toISOString(),
  };
  const scrubbed = scrubSecretValues(payload, {
    extra: args.redirectUrl ? [args.redirectUrl] : [],
  });
  console.info(JSON.stringify(scrubbed));
}
