/**
 * The page a household sees when the payment provider sends them back to
 * MGM after a hosted checkout (src/app/payment/callback/route.ts). It says
 * one of two things: the payment's status has been checked with the
 * provider, or confirmation is pending. "Checked" covers a failed payment
 * too, so the page never says the bill is paid, never uses a success
 * colour and shows no amount, bill or reference.
 *
 * Pure: the route reads the rows and the logo bytes and passes them in.
 */
import { InvoiceConfigSchema } from "@/lib/invoices/config-schema";
import { PUBLIC_COPY, type PublicLanguage } from "./copy";
import { clip, MAX_LOGO_BYTES, renderPublicPage, type PublicAction, type PublicBrand } from "./page";

export type ReceiptOutcome = "checked" | "pending";

export interface ReceiptBrand extends PublicBrand {
  /** The operator's WhatsApp number as they stored it; set only when it has digits. */
  whatsappNumber?: string;
}

export interface ReceiptBranding {
  brand: ReceiptBrand;
  /** The stored invoice logo's path in its bucket, when the branding names one. */
  logoPath: string | null;
}

/** The content types a stored logo may have for the page to download it. */
export const RECEIPT_LOGO_CONTENT_TYPES: readonly string[] = ["image/png", "image/jpeg"];

/** The bytes each format starts with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

/** The WhatsApp chat link for a stored number, or null when it has no digits. */
export function whatsappHref(number: string): string | null {
  const digits = number.replace(/[^0-9]/g, "");
  return digits ? `https://wa.me/${digits}` : null;
}

/**
 * Who the page names, from the community's row: its name, its
 * organization's name and its invoice configuration.
 *
 * The rule is the PDF bill's (renderInvoicePdf in
 * src/lib/invoices/render.tsx): the seller's trade name, else the
 * organization's name; the WhatsApp number from the branding, else the
 * seller's contact phone; the operator's colour from the branding. If the
 * bill's rule changes, change this one with it, so a household sees the
 * same name on both. The community goes beneath when it differs. An
 * invoice configuration that does not parse gives the names only.
 */
export function receiptBranding(row: {
  communityName: string | null;
  organizationName: string | null;
  invoiceConfig: unknown;
}): ReceiptBranding | null {
  const communityName = row.communityName?.trim() || null;
  const organizationName = row.organizationName?.trim() || null;
  const parsed = InvoiceConfigSchema.safeParse(row.invoiceConfig);
  const config = parsed.success ? parsed.data : null;
  const name = config?.seller?.trade_name?.trim() || organizationName || communityName;
  if (!name) return null;

  const brand: ReceiptBrand = { name };
  if (communityName && communityName !== name) brand.subtitle = communityName;
  if (!config) return { brand, logoPath: null };

  const branding = config.branding ?? {};
  if (branding.primary_color) brand.accentHex = branding.primary_color;
  const number = (branding.whatsapp_number ?? config.seller?.contact_phone ?? "").trim();
  if (whatsappHref(number)) brand.whatsappNumber = number;
  const logoPath = branding.logo_storage_path?.trim() ? branding.logo_storage_path : null;
  return { brand, logoPath };
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);
}

/**
 * A downloaded logo as a data URI the page can embed, or undefined unless
 * it is a PNG or JPEG (by its first bytes, whatever it was stored as) of at
 * most MAX_LOGO_BYTES. An SVG never qualifies.
 */
export function logoDataUri(bytes: Uint8Array): string | undefined {
  if (bytes.length > MAX_LOGO_BYTES) return undefined;
  const format = startsWith(bytes, PNG_SIGNATURE) ? "png" : startsWith(bytes, JPEG_SIGNATURE) ? "jpeg" : null;
  if (!format) return undefined;
  return `data:image/${format};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** `template` with each `{key}` replaced by its value; an unknown key stays as written. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? values[key] : placeholder,
  );
}

/** The return page as a complete HTML document. */
export function renderReceipt(input: {
  lang: PublicLanguage;
  outcome: ReceiptOutcome;
  brand: ReceiptBrand | null;
}): string {
  const copy = PUBLIC_COPY[input.lang].receipt;
  const checked = input.outcome === "checked";
  const heading = checked ? copy.checkedHeading : copy.pendingHeading;
  const paragraphs: string[] = [checked ? copy.checked : copy.pending];
  const actions: PublicAction[] = [];
  const brand = input.brand;
  const href = brand?.whatsappNumber ? whatsappHref(brand.whatsappNumber) : null;
  if (brand?.whatsappNumber && href) {
    // The frame cuts the brand header's name; text placed here is cut the
    // same way so the page keeps its size.
    paragraphs.push(fill(copy.whatsappPrompt, { name: clip(brand.name) }));
    actions.push({ href, label: fill(copy.whatsappButton, { number: clip(brand.whatsappNumber) }) });
  }
  return renderPublicPage({
    lang: input.lang,
    title: heading,
    heading,
    paragraphs,
    tone: checked ? "neutral" : "warning",
    brand: brand
      ? { name: brand.name, subtitle: brand.subtitle, accentHex: brand.accentHex, logoDataUri: brand.logoDataUri }
      : undefined,
    actions,
  });
}
