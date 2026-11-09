/**
 * GET /payment/callback: where the payment provider sends a household back
 * after a hosted checkout. The answer is a small HTML page with no
 * JavaScript (src/lib/public-html/receipt.ts), status 200 in every case.
 *
 * The provider appends OrderTrackingId and OrderMerchantReference. They are
 * never taken as proof of payment. Only when each appears exactly once and
 * is not empty is the stored attempt with that merchant reference looked
 * up; only when one exists does the Payments capability check the
 * transaction with the provider (handleNotification, which receives those
 * two values and nothing else from the query). The page says the status
 * was checked when handleNotification processed it, a failed payment
 * included, and that confirmation is pending in every other case, an error
 * included.
 *
 * For a matched attempt the page also names the operator from its
 * community's invoice branding, read here with enumerated columns. That
 * read runs beside the check, with its own lookup, swallows its own errors
 * and stops waiting after BRAND_TIMEOUT_MS, so branding can never change
 * whether or how a payment is checked, nor hold up the answer by more than
 * that. An unmatched reference reads nothing more.
 *
 * GET checks. Next.js answers HEAD by running GET, so a HEAD request checks
 * the payment as a GET does; to stop that, export a HEAD that answers
 * without the lookup. POST shows the plain pending page and checks nothing,
 * so a household brought back with a POST still sees a page rather than an
 * error. PUT, PATCH and DELETE get 405, OPTIONS the allowed methods.
 */
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { composePaymentsPublic } from "@/lib/payments/compose";
import { pickPublicLanguage } from "@/lib/public-html/copy";
import { MAX_LOGO_BYTES, publicHtmlResponse } from "@/lib/public-html/page";
import {
  logoDataUri,
  logoInCommunity,
  RECEIPT_LOGO_CONTENT_TYPES,
  receiptBranding,
  renderReceipt,
  type ReceiptBrand,
  type ReceiptOutcome,
} from "@/lib/public-html/receipt";

export const dynamic = "force-dynamic";

/**
 * The longest the page waits for the operator's branding (the community,
 * its invoice configuration and its logo) before it answers without it.
 */
const BRAND_TIMEOUT_MS = 2000;

/** The parameter's value when it appears exactly once; "" when it is missing or repeated. */
function single(params: URLSearchParams, name: string): string {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : "";
}

/**
 * Whether the capability processed the provider's answer for this attempt.
 * Never rejects: any error means "not checked".
 */
async function verify(
  supabase: SupabaseClient,
  organizationId: string,
  tracking: string,
  reference: string,
): Promise<boolean> {
  let checked = false;
  try {
    const composed = await composePaymentsPublic({ supabase, organizationId });
    if (composed.ok) {
      try {
        const result = await composed.data.payments.handleNotification({
          OrderTrackingId: tracking,
          OrderMerchantReference: reference,
        });
        if (result.ok && result.data.processed) checked = true;
      } finally {
        await composed.data.dispose();
      }
    }
  } catch {
    /* Never trust redirect parameters as proof of settlement. */
  }
  return checked;
}

/** A stored logo's size and type, wherever the storage API reports them. */
function logoInfo(info: unknown): { size?: unknown; contentType?: unknown } {
  const record = (info ?? {}) as { size?: unknown; contentType?: unknown; metadata?: unknown };
  const metadata = (record.metadata ?? {}) as { size?: unknown; mimetype?: unknown };
  return { size: record.size ?? metadata.size, contentType: record.contentType ?? metadata.mimetype };
}

/**
 * The invoice logo as a data URI, or undefined. Downloads only a PNG or
 * JPEG the storage API reports at MAX_LOGO_BYTES or less, and embeds it only
 * if the bytes agree. No URL to the bucket ever reaches the page.
 */
async function readLogo(supabase: SupabaseClient, path: string): Promise<string | undefined> {
  const { data: info, error } = await supabase.storage.from("invoice-logos").info(path);
  if (error || !info) return undefined;
  const { size, contentType } = logoInfo(info);
  if (typeof contentType !== "string" || !RECEIPT_LOGO_CONTENT_TYPES.includes(contentType)) return undefined;
  if (typeof size !== "number" || size > MAX_LOGO_BYTES) return undefined;
  const { data: blob, error: downloadError } = await supabase.storage.from("invoice-logos").download(path);
  if (downloadError || !blob) return undefined;
  return logoDataUri(new Uint8Array(await blob.arrayBuffer()));
}

/** `promise`'s value, or undefined if it rejects or takes longer than `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The operator's brand for the attempt with this merchant reference, or
 * null. Never rejects and never takes longer than BRAND_TIMEOUT_MS: any
 * error leaves the page unbranded, and a read still running at the
 * deadline leaves it with the names read so far, without the logo.
 */
async function readBrand(supabase: SupabaseClient, reference: string): Promise<ReceiptBrand | null> {
  const read: { names: ReceiptBrand | null } = { names: null };
  const brand = await within(
    lookUpBrand(supabase, reference, (names) => {
      read.names = names;
    }),
    BRAND_TIMEOUT_MS,
  );
  return brand ?? read.names;
}

/**
 * readBrand's reads, with no deadline of their own. `onNames` receives the
 * brand without its logo as soon as it is known, before the logo is read.
 *
 * Every select names its columns. communities also holds the community's
 * payment provider settings, which this page must never read; naming the
 * columns keeps those, and any column added to the table later, off this
 * public page.
 *
 * The service role reads the logo, so this page decides which file it may
 * embed: only one in the attempt's own community folder (logoInCommunity).
 */
async function lookUpBrand(
  supabase: SupabaseClient,
  reference: string,
  onNames: (brand: ReceiptBrand) => void,
): Promise<ReceiptBrand | null> {
  try {
    const { data: attempt } = await supabase
      .from("payment_attempts")
      .select("community_id")
      .eq("merchant_reference", reference)
      .maybeSingle<{ community_id: string | null }>();
    if (!attempt?.community_id) return null;
    const { data: community } = await supabase
      .from("communities")
      .select("name, invoice_config, organizations(name)")
      .eq("id", attempt.community_id)
      .maybeSingle<{
        name: string | null;
        invoice_config: unknown;
        organizations: { name: string | null } | { name: string | null }[] | null;
      }>();
    if (!community) return null;
    const organization = Array.isArray(community.organizations)
      ? community.organizations[0]
      : community.organizations;
    const branding = receiptBranding({
      communityName: community.name,
      organizationName: organization?.name ?? null,
      invoiceConfig: community.invoice_config,
    });
    if (!branding) return null;
    onNames(branding.brand);
    if (!branding.logoPath || !logoInCommunity(branding.logoPath, attempt.community_id)) return branding.brand;
    // A logo read that fails drops the logo and keeps the names.
    const logo = await readLogo(supabase, branding.logoPath).catch(() => undefined);
    return logo ? { ...branding.brand, logoDataUri: logo } : branding.brand;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const tracking = single(request.nextUrl.searchParams, "OrderTrackingId");
  const reference = single(request.nextUrl.searchParams, "OrderMerchantReference");
  let checked = false;
  let brand: ReceiptBrand | null = null;
  if (tracking && reference) {
    try {
      const supabase = createServiceClient();
      const { data: attempt } = await supabase
        .from("payment_attempts")
        .select("org_id")
        .eq("merchant_reference", reference)
        .maybeSingle<{ org_id: string }>();
      if (attempt) {
        // Neither rejects, so a branding failure cannot hide the check's answer.
        [checked, brand] = await Promise.all([
          verify(supabase, attempt.org_id, tracking, reference),
          readBrand(supabase, reference),
        ]);
      }
    } catch {
      /* Never trust redirect parameters as proof of settlement. */
    }
  }
  return receiptResponse(request, checked ? "checked" : "pending", brand);
}

/**
 * The plain pending page, with no lookup and no check. The provider is
 * expected to bring a household back with a GET; this keeps a POST from
 * landing them on an error. The body is never read.
 */
export async function POST(request: NextRequest): Promise<Response> {
  return receiptResponse(request, "pending", null);
}

function receiptResponse(request: NextRequest, outcome: ReceiptOutcome, brand: ReceiptBrand | null): Response {
  const lang = pickPublicLanguage(request.headers.get("accept-language"));
  return publicHtmlResponse(200, renderReceipt({ lang, outcome, brand }), {
    "Content-Language": lang,
    Vary: "Accept-Language",
  });
}
