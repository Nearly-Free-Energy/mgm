import { describe, expect, it } from "vitest";
import { MAX_BRAND_CHARS, MAX_LOGO_BYTES } from "../page";
import { PALETTE } from "../palette";
import {
  logoDataUri,
  logoInCommunity,
  receiptBranding,
  renderReceipt,
  whatsappHref,
  type ReceiptBrand,
} from "../receipt";

const CHECKED =
  "Your payment status has been checked. Your operator can confirm the receipt and any outstanding balance.";
const PENDING = "Payment confirmation is pending. Please contact your operator before trying again.";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];

/** `length` bytes that start with `signature`. */
function bytesOf(signature: readonly number[], length: number): Uint8Array {
  const bytes = new Uint8Array(length).fill(0x41);
  bytes.set(signature.slice(0, length));
  return bytes;
}

const BRAND: ReceiptBrand = {
  name: "Example Energy",
  subtitle: "Example Community",
  accentHex: "#163a5f",
  whatsappNumber: "+256 700 000 001",
};

describe("renderReceipt", () => {
  it("says the status was checked, in today's words, without a warning", () => {
    const html = renderReceipt({ lang: "en", outcome: "checked", brand: null });
    expect(html).toContain("<title>Payment checked</title>");
    expect(html).toContain(`<main>\n<h1>Payment checked</h1>\n<p>${CHECKED}</p>\n</main>`);
  });

  it("says confirmation is pending, in today's words, as a warning", () => {
    const html = renderReceipt({ lang: "en", outcome: "pending", brand: null });
    expect(html).toContain("<title>Payment not confirmed yet</title>");
    expect(html).toContain(`<main class="warning">\n<h1>Payment not confirmed yet</h1>\n<p>${PENDING}</p>\n</main>`);
  });

  it.each(["checked", "pending"] as const)("never says a %s payment is paid or shows a success colour", (outcome) => {
    const html = renderReceipt({ lang: "en", outcome, brand: BRAND });
    expect(html).not.toMatch(/\bpaid\b|success|receipt number|UGX/i);
    const colours = new Set(html.match(/#[0-9a-f]{6}\b/gi));
    const allowed = new Set([...Object.values(PALETTE.light), ...Object.values(PALETTE.dark), BRAND.accentHex]);
    expect([...colours].filter((colour) => !allowed.has(colour))).toEqual([]);
  });

  it("leaves out the brand header and the WhatsApp contact without a brand", () => {
    const html = renderReceipt({ lang: "en", outcome: "checked", brand: null });
    expect(html).not.toContain("<header");
    expect(html).not.toContain("WhatsApp");
    expect(html).not.toContain("<a ");
  });

  it("names the operator and the community, in the operator's colour", () => {
    const html = renderReceipt({ lang: "en", outcome: "checked", brand: BRAND });
    expect(html).toContain('<p class="name">Example Energy</p><p class="sub">Example Community</p>');
    expect(html).toContain(".brand{border-top-color:#163a5f}</style>");
  });

  it("offers the operator's WhatsApp chat, with the number as they stored it", () => {
    const html = renderReceipt({ lang: "en", outcome: "pending", brand: BRAND });
    expect(html).toContain("<p>Questions about this payment? Message Example Energy on WhatsApp.</p>");
    expect(html).toContain(
      '<a class="btn" href="https://wa.me/256700000001" rel="noreferrer noopener">WhatsApp +256 700 000 001</a>',
    );
  });

  it("leaves out the WhatsApp contact when the brand has no number, or one with no digits", () => {
    for (const whatsappNumber of [undefined, "", "call us"]) {
      const html = renderReceipt({ lang: "en", outcome: "checked", brand: { ...BRAND, whatsappNumber } });
      expect(html).not.toContain("WhatsApp");
      expect(html).toContain('<p class="name">Example Energy</p>');
    }
  });

  it("escapes the operator's name wherever it appears", () => {
    const html = renderReceipt({
      lang: "en",
      outcome: "checked",
      brand: { name: '<script>alert(1)</script> & "Co"', whatsappNumber: "0700<b>1</b>" },
    });
    expect(html).not.toMatch(/<script|<b>/i);
    expect(html).toContain("Message &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot; on WhatsApp.");
    expect(html).toContain('href="https://wa.me/07001"');
    expect(html).toContain(">WhatsApp 0700&lt;b&gt;1&lt;/b&gt;</a>");
  });

  it("cuts a long name short in the WhatsApp line as in the header", () => {
    const name = "n".repeat(MAX_BRAND_CHARS + 100);
    const html = renderReceipt({ lang: "en", outcome: "checked", brand: { name, whatsappNumber: "0700000001" } });
    const cut = `${"n".repeat(MAX_BRAND_CHARS - 1)}…`;
    expect(html).toContain(`<p class="name">${cut}</p>`);
    expect(html).toContain(`<p>Questions about this payment? Message ${cut} on WhatsApp.</p>`);
    expect(html).not.toContain("n".repeat(MAX_BRAND_CHARS));
  });

  it("stays under 15 KB with the longest names, the largest logo and a WhatsApp contact", () => {
    // Longer than any brand keeps, in the character that grows most when escaped.
    const long = '"'.repeat(MAX_BRAND_CHARS * 5);
    for (const outcome of ["checked", "pending"] as const) {
      const html = renderReceipt({
        lang: "en",
        outcome,
        brand: {
          name: long,
          subtitle: long,
          accentHex: "#123456",
          logoDataUri: logoDataUri(bytesOf(PNG, MAX_LOGO_BYTES)),
          whatsappNumber: `+${"9".repeat(MAX_BRAND_CHARS * 5)}`,
        },
      });
      expect(html).toContain("<img ");
      expect(html).not.toMatch(/<script/i);
      expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(15 * 1024);
    }
  });

  it("stays under 4 KB without a brand", () => {
    for (const outcome of ["checked", "pending"] as const) {
      const html = renderReceipt({ lang: "en", outcome, brand: null });
      expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(4096);
    }
  });
});

describe("receiptBranding", () => {
  const row = (invoiceConfig: unknown, names: { community?: string | null; organization?: string | null } = {}) => ({
    communityName: names.community === undefined ? "Example Community" : names.community,
    organizationName: names.organization === undefined ? "Example Organization" : names.organization,
    invoiceConfig,
  });

  it("names the organization, with the community beneath, when the community has no invoice branding", () => {
    expect(receiptBranding(row({}))).toEqual({
      brand: { name: "Example Organization", subtitle: "Example Community" },
      logoPath: null,
    });
  });

  it("prefers the seller's trade name, as the PDF bill does", () => {
    const config = { seller: { legal_name: "Example Energy Ltd", trade_name: "  Example Energy  " } };
    expect(receiptBranding(row(config))?.brand.name).toBe("Example Energy");
    const blank = { seller: { legal_name: "Example Energy Ltd", trade_name: "   " } };
    expect(receiptBranding(row(blank))?.brand.name).toBe("Example Organization");
  });

  it("leaves the community out when it is the same name", () => {
    expect(receiptBranding(row({}, { community: "Example Organization" }))?.brand).toEqual({
      name: "Example Organization",
    });
  });

  it("falls back to the community's name, and to nothing, when names are missing", () => {
    expect(receiptBranding(row({}, { organization: null }))?.brand).toEqual({ name: "Example Community" });
    expect(receiptBranding(row({}, { organization: " ", community: null }))).toBeNull();
  });

  it("takes the colour, the WhatsApp number and the logo path from the branding", () => {
    const config = {
      seller: { legal_name: "Example Energy Ltd", contact_phone: "+256 700 000 002" },
      branding: { primary_color: "#163a5f", whatsapp_number: " +256 700 000 001 ", logo_storage_path: "c-1/logo.png" },
    };
    expect(receiptBranding(row(config))).toEqual({
      brand: {
        name: "Example Organization",
        subtitle: "Example Community",
        accentHex: "#163a5f",
        whatsappNumber: "+256 700 000 001",
      },
      logoPath: "c-1/logo.png",
    });
  });

  it("uses the seller's contact phone when the branding has no WhatsApp number, as the PDF bill does", () => {
    const seller = { legal_name: "Example Energy Ltd", contact_phone: "0700 000 002" };
    expect(receiptBranding(row({ seller }))?.brand.whatsappNumber).toBe("0700 000 002");
    expect(receiptBranding(row({ seller, branding: { whatsapp_number: null } }))?.brand.whatsappNumber).toBe(
      "0700 000 002",
    );
    // An empty number hides the contact on the bill, so it does here too.
    expect(receiptBranding(row({ seller, branding: { whatsapp_number: "" } }))?.brand).not.toHaveProperty(
      "whatsappNumber",
    );
    expect(receiptBranding(row({ branding: { whatsapp_number: "ask us" } }))?.brand).not.toHaveProperty(
      "whatsappNumber",
    );
  });

  it("ignores a blank logo path", () => {
    expect(receiptBranding(row({ branding: { logo_storage_path: "  " } }))?.logoPath).toBeNull();
    expect(receiptBranding(row({ branding: { logo_storage_path: null } }))?.logoPath).toBeNull();
  });

  it.each([
    ["an unknown key", { extra: true, branding: { primary_color: "#163a5f" } }],
    ["a seller without a legal name", { seller: { trade_name: "Example Energy" }, branding: { whatsapp_number: "0700" } }],
    ["a colour that is not #rrggbb", { branding: { primary_color: "red", whatsapp_number: "0700" } }],
    ["not an object", "corrupt"],
    ["null", null],
  ])("gives the names only for an invoice configuration with %s", (_, config) => {
    expect(receiptBranding(row(config))).toEqual({
      brand: { name: "Example Organization", subtitle: "Example Community" },
      logoPath: null,
    });
  });
});

describe("whatsappHref", () => {
  it.each([
    ["+256 700 000 001", "https://wa.me/256700000001"],
    ["(0700) 000-001", "https://wa.me/0700000001"],
    ["", null],
    ["no digits", null],
    ["١٢٣", null],
  ])("links %j to %j", (number, href) => {
    expect(whatsappHref(number)).toBe(href);
  });
});

describe("logoInCommunity", () => {
  const COMMUNITY = "c0000000-0000-4000-8000-000000000001";

  it("accepts a file in the community's own folder, as the logo upload stores it", () => {
    expect(logoInCommunity(`${COMMUNITY}/1762500000000-0f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f.png`, COMMUNITY)).toBe(true);
  });

  it.each([
    ["another community's folder", "c0000000-0000-4000-8000-000000000002/logo.png"],
    ["no folder", "logo.png"],
    ["a folder that only starts with the id", `${COMMUNITY}0/logo.png`],
    ["a folder below the community's", `${COMMUNITY}/other/logo.png`],
    ["a climb out of the folder", `${COMMUNITY}/../logo.png`],
    ["the folder's parent", `${COMMUNITY}/..`],
    ["the folder itself", `${COMMUNITY}/`],
    ["a backslash", `${COMMUNITY}/other\\logo.png`],
  ])("refuses %s", (_, path) => {
    expect(logoInCommunity(path, COMMUNITY)).toBe(false);
  });

  it("refuses every path when there is no community", () => {
    expect(logoInCommunity("/logo.png", "")).toBe(false);
  });
});

describe("logoDataUri", () => {
  it("embeds a PNG or a JPEG of at most the largest size", () => {
    expect(logoDataUri(bytesOf(PNG, 300))).toBe(
      `data:image/png;base64,${Buffer.from(bytesOf(PNG, 300)).toString("base64")}`,
    );
    expect(logoDataUri(bytesOf(JPEG, 300))?.startsWith("data:image/jpeg;base64,/9j/")).toBe(true);
    expect(logoDataUri(bytesOf(PNG, MAX_LOGO_BYTES))).toBeDefined();
  });

  it.each([
    ["a PNG one byte too large", bytesOf(PNG, MAX_LOGO_BYTES + 1)],
    ["an SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ["a GIF", new TextEncoder().encode("GIF89a....")],
    ["a truncated PNG signature", bytesOf(PNG.slice(0, 4), 4)],
    ["nothing", new Uint8Array(0)],
  ])("refuses %s", (_, bytes) => {
    expect(logoDataUri(bytes)).toBeUndefined();
  });
});
