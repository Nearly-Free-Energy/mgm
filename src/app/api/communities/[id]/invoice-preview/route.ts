import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import { PreviewInvoiceBody } from "@/lib/billing/schemas";
import { parseJsonBody } from "@/lib/validation/parse-body";
import {
  assembleSyntheticPreviewInput,
  type PreviewRateSchedule,
} from "@/lib/invoices/preview-input";
import { renderInvoicePdf } from "@/lib/invoices/render";

/**
 * POST /api/communities/[id]/invoice-preview — Render a synthetic preview PDF
 * (#204 / PDF2 AC #5).
 *
 * Click-flow chosen: Pattern A (fetch + blob). The client opens
 * `window.open('about:blank')` synchronously inside the click handler, then
 * POSTs to this route, then sets the popup's `location` to the blob URL.
 *
 * Checks in the PATCH config route's order — UUID → body → row read →
 * 404 → `currentUserCanAccessOrg` → 403. The synthetic preview must NOT be a
 * public endpoint.
 *
 * Body shape (`PreviewInvoiceBody`, `@/lib/billing/schemas`; mirrors the
 * PATCH body — the form passes its in-memory state):
 *   {
 *     invoice_prefix: string | null,  // "" is read as null
 *     invoice_config: InvoiceConfig,
 *   }
 * Unknown top-level keys are refused. A malformed body answers 400
 * { error, field?, code: "invalid_body" } before the community is read.
 *
 * Synthesised content:
 *   - `paymentRedirectUrl = 'https://example.com/preview-payment'` — fake URL
 *     so the Payment Information card always renders. The link 404s if
 *     clicked; acceptable for branding-feedback preview.
 *   - `invoiceNumber = '${invoice_prefix || 'PREVIEW'}-{year}-PREVIEW'` —
 *     does NOT call `fn_next_invoice_number()`.
 *   - `logoBytes` — fetched via service-role signed URL (60s TTL) when the
 *     posted config has a `branding.logo_storage_path`; null otherwise.
 *   - `ratesSchedule` — fetched from the community's first microgrid; falls
 *     back to a synthetic 1-tier schedule when none exists yet.
 *
 * Returns: PDF stream with `Content-Disposition: inline; filename="preview.pdf"`
 * — distinct from PDF1b's `attachment` (downloaded bills).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PREVIEW_PAYMENT_REDIRECT_URL = "https://example.com/preview-payment";

const SIGNED_LOGO_TTL_SECONDS = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: communityId } = await params;

  // (1) UUID parse.
  if (!UUID_RE.test(communityId)) {
    return NextResponse.json(
      { error: "Invalid community id — expected UUID." },
      { status: 400 },
    );
  }

  // (2) Body. Parsed (and validated, as defense-in-depth — the operator's
  // form already validates client-side, but a malformed body here would
  // crash the renderer with an opaque error) before the read: the answer
  // depends only on the body the caller sent.
  const parsed = await parseJsonBody(request, PreviewInvoiceBody);
  if (!parsed.ok) return parsed.response;
  const invoicePrefix = parsed.data.invoice_prefix || null;
  const invoiceConfig = parsed.data.invoice_config;

  const supabase = await createClient();

  // (3) Row read — RLS-hidden / missing → 404.
  const { data: community, error: commErr } = await supabase
    .from("communities")
    .select("id, org_id, name")
    .eq("id", communityId)
    .maybeSingle<{ id: string; org_id: string; name: string }>();

  if (commErr) {
    return NextResponse.json(
      { error: `Failed to read community: ${commErr.message}` },
      { status: 500 },
    );
  }
  if (!community) {
    return NextResponse.json(
      { error: "Community not found." },
      { status: 404 },
    );
  }

  // (4) Permission.
  if (!(await currentUserCanAccessOrg(supabase, community.org_id))) {
    return NextResponse.json(
      {
        error:
          "You do not have permission to preview invoices for this community.",
      },
      { status: 403 },
    );
  }

  // (6) Resolve organization name (renderer's seller fallback).
  const { data: organization } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("id", community.org_id)
    .maybeSingle<{ id: string; name: string }>();

  if (!organization) {
    return NextResponse.json(
      { error: "Could not resolve parent organization for this community." },
      { status: 500 },
    );
  }

  // (7) Resolve a real rate schedule from the first microgrid; fall back to
  // a synthetic 1-tier schedule when none exists yet (operator is configuring
  // invoice settings before any microgrids are added).
  const { data: microgrid } = await supabase
    .from("microgrids")
    .select("id")
    .eq("community_id", community.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>();

  let ratesSchedule: PreviewRateSchedule | null = null;
  if (microgrid) {
    const { data: schedule } = await supabase
      .from("rate_schedules")
      .select(
        "id, microgrid_id, tiers, service_charge, service_charge_description, tax_rate",
      )
      .eq("microgrid_id", microgrid.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{
        id: string;
        microgrid_id: string;
        tiers: unknown;
        service_charge: number;
        service_charge_description: string | null;
        tax_rate: number;
      }>();
    if (schedule) {
      const tiers = Array.isArray(schedule.tiers)
        ? (schedule.tiers as PreviewRateSchedule["tiers"])
        : [];
      ratesSchedule = {
        id: schedule.id,
        microgrid_id: schedule.microgrid_id,
        tiers,
        service_charge: schedule.service_charge,
        service_charge_description: schedule.service_charge_description,
        tax_rate: schedule.tax_rate,
      };
    }
  }

  // (8) Synthesize the renderer input bag (excluding logoBytes + paymentRedirectUrl).
  const baseInput = assembleSyntheticPreviewInput({
    community: {
      id: community.id,
      name: community.name,
      invoice_config: invoiceConfig,
      invoice_prefix: invoicePrefix,
    },
    organization: { id: organization.id, name: organization.name },
    ratesSchedule,
  });

  // (9) Fetch logo bytes via service-role signed URL when the posted config
  // has a logo_storage_path.
  let logoBytes: Buffer | null = null;
  const logoPath = invoiceConfig.branding?.logo_storage_path ?? null;
  if (logoPath) {
    const service = createServiceClient();
    const { data: signed } = await service.storage
      .from("invoice-logos")
      .createSignedUrl(logoPath, SIGNED_LOGO_TTL_SECONDS);
    if (signed?.signedUrl) {
      try {
        const resp = await fetch(signed.signedUrl);
        if (resp.ok) {
          const ab = await resp.arrayBuffer();
          logoBytes = Buffer.from(ab);
        }
      } catch {
        // Logo fetch failed — preview proceeds with logoBytes=null. The
        // renderer falls back to text-only header rendering.
        logoBytes = null;
      }
    }
  }

  // (10) Render. Returns 503 until PDF1b lands and the stub is removed.
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderInvoicePdf({
      ...baseInput,
      logoBytes,
      paymentRedirectUrl: PREVIEW_PAYMENT_REDIRECT_URL,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          "Failed to render preview: " +
          (err instanceof Error ? err.message : "unknown error"),
      },
      { status: 500 },
    );
  }

  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="preview.pdf"',
      "Cache-Control": "no-store",
    },
  });
}
