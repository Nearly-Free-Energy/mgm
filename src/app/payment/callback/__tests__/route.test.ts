import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PUBLIC_PAGE_SECURITY_HEADERS } from "@/lib/public-html/page";

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  compose: vi.fn(),
  handle: vi.fn(),
  dispose: vi.fn(),
  info: vi.fn(),
  download: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock("@/lib/payments/compose", () => ({ composePaymentsPublic: mocks.compose }));

import * as route from "../route";

const CHECKED =
  "Your payment status has been checked. Your operator can confirm the receipt and any outstanding balance.";
const PENDING = "Payment confirmation is pending. Please contact your operator before trying again.";

const REFERENCE = "MGM-6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f";
const TRACKING = "b2d1c3e4-0000-4000-8000-000000000001";
const COMMUNITY_ID = "c0000000-0000-4000-8000-000000000001";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Query = { table: string; columns: string; filters: Record<string, unknown> };
type Answer = { data: unknown; error: unknown };

let queries: Query[];
let buckets: string[];
/** What each table answers; a function may throw to fail the query. */
let tables: Record<string, (query: Query) => Answer>;

/** The requested columns of `row`, as PostgREST would return them. */
function pick(row: Record<string, unknown>, columns: string): Record<string, unknown> {
  const names = columns.split(",").map((column) => column.trim().replace(/\(.*\)$/, ""));
  return Object.fromEntries(names.map((name) => [name, row[name]]));
}

function fakeClient() {
  return {
    from(table: string) {
      const query: Query = { table, columns: "", filters: {} };
      queries.push(query);
      const builder = {
        select(columns: string) {
          query.columns = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          query.filters[column] = value;
          return builder;
        },
        maybeSingle: async () => (tables[table] ?? (() => ({ data: null, error: null })))(query),
      };
      return builder;
    },
    storage: {
      from(bucket: string) {
        buckets.push(bucket);
        return { info: mocks.info, download: mocks.download };
      },
    },
  };
}

function attemptsTable(row: Record<string, unknown> | null = { org_id: "org-1", community_id: COMMUNITY_ID }) {
  return (query: Query): Answer =>
    row && query.filters.merchant_reference === REFERENCE
      ? { data: pick(row, query.columns), error: null }
      : { data: null, error: null };
}

function communitiesTable(invoiceConfig: unknown = {}, organizationName: string | null = "Example Organization") {
  return (query: Query): Answer =>
    query.filters.id === COMMUNITY_ID
      ? {
          data: {
            name: "Example Community",
            invoice_config: invoiceConfig,
            organizations: organizationName === null ? null : { name: organizationName },
          },
          error: null,
        }
      : { data: null, error: null };
}

function pngBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length).fill(0x41);
  bytes.set(PNG);
  return bytes;
}

function request(query: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://mgm.test/payment/callback${query}`, { headers });
}

const RETURN = `?OrderTrackingId=${TRACKING}&OrderMerchantReference=${REFERENCE}&OrderNotificationType=CALLBACKURL`;

async function open(query = RETURN, headers: Record<string, string> = {}) {
  const res = await route.GET(request(query, headers));
  return { res, html: await res.text() };
}

beforeEach(() => {
  vi.clearAllMocks();
  queries = [];
  buckets = [];
  tables = { payment_attempts: attemptsTable(), communities: communitiesTable() };
  mocks.createServiceClient.mockImplementation(fakeClient);
  mocks.dispose.mockResolvedValue(undefined);
  mocks.handle.mockResolvedValue({ ok: true, data: { processed: true, attemptId: "attempt-1" } });
  mocks.compose.mockResolvedValue({
    ok: true,
    data: { payments: { handleNotification: mocks.handle }, dispose: mocks.dispose },
  });
  mocks.info.mockResolvedValue({ data: null, error: new Error("not found") });
  mocks.download.mockResolvedValue({ data: null, error: new Error("not found") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /payment/callback: the payment check", () => {
  it.each([
    ["no parameters", ""],
    ["no merchant reference", `?OrderTrackingId=${TRACKING}`],
    ["no tracking id", `?OrderMerchantReference=${REFERENCE}`],
    ["an empty tracking id", `?OrderTrackingId=&OrderMerchantReference=${REFERENCE}`],
    ["a repeated tracking id", `?OrderTrackingId=${TRACKING}&OrderTrackingId=${TRACKING}&OrderMerchantReference=${REFERENCE}`],
    ["a repeated merchant reference", `?OrderTrackingId=${TRACKING}&OrderMerchantReference=${REFERENCE}&OrderMerchantReference=x`],
  ])("says confirmation is pending and looks nothing up for %s", async (_, query) => {
    const { res, html } = await open(query);
    expect(res.status).toBe(200);
    expect(html).toContain(`<p>${PENDING}</p>`);
    expect(html).not.toContain("<header");
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.compose).not.toHaveBeenCalled();
  });

  it("checks the attempt and says so when the capability processed it", async () => {
    const { res, html } = await open();
    expect(res.status).toBe(200);
    expect(html).toContain("<h1>Payment checked</h1>");
    expect(html).toContain(`<p>${CHECKED}</p>`);
    expect(html).not.toContain(PENDING);
    expect(mocks.compose).toHaveBeenCalledOnce();
    expect(mocks.compose.mock.calls[0][0]).toMatchObject({ organizationId: "org-1" });
    expect(mocks.compose.mock.calls[0][0].supabase).toBe(mocks.createServiceClient.mock.results[0].value);
    // Exactly the two values, nothing else from the query: this is stored as the raw payload.
    expect(mocks.handle).toHaveBeenCalledOnce();
    expect(mocks.handle.mock.calls[0]).toEqual([{ OrderTrackingId: TRACKING, OrderMerchantReference: REFERENCE }]);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("finds the attempt with the same lookup as before, by exact merchant reference", async () => {
    await open();
    expect(queries[0]).toEqual({
      table: "payment_attempts",
      columns: "org_id",
      filters: { merchant_reference: REFERENCE },
    });
  });

  it("says confirmation is pending, and reads nothing more, for a reference with no attempt", async () => {
    tables.payment_attempts = attemptsTable(null);
    const { res, html } = await open();
    expect(res.status).toBe(200);
    expect(html).toContain(`<p>${PENDING}</p>`);
    expect(html).not.toContain("<header");
    expect(mocks.compose).not.toHaveBeenCalled();
    expect(queries.map((query) => query.table)).toEqual(["payment_attempts"]);
    expect(buckets).toEqual([]);
  });

  it.each([
    ["the capability did not process it", () => mocks.handle.mockResolvedValue({ ok: true, data: { processed: false, attemptId: "a" } })],
    ["the capability refused", () => mocks.handle.mockResolvedValue({ ok: false, status: 409, code: "payments_scope_mismatch" })],
    ["the check threw", () => mocks.handle.mockRejectedValue(new Error("provider unavailable"))],
  ])("says confirmation is pending when %s, and still closes the scope", async (_, arrange) => {
    arrange();
    const { res, html } = await open();
    expect(res.status).toBe(200);
    expect(html).toContain(`<p>${PENDING}</p>`);
    expect(html).not.toContain(CHECKED);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["composition failed", () => mocks.compose.mockResolvedValue({ ok: false, status: 503, code: "payments_gate_unavailable" })],
    ["composition threw", () => mocks.compose.mockRejectedValue(new Error("runtime unavailable"))],
  ])("says confirmation is pending when %s, with nothing to close", async (_, arrange) => {
    arrange();
    const { res, html } = await open();
    expect(res.status).toBe(200);
    expect(html).toContain(`<p>${PENDING}</p>`);
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.dispose).not.toHaveBeenCalled();
  });

  it("keeps the checked answer when closing the scope fails afterwards, as before", async () => {
    mocks.dispose.mockRejectedValue(new Error("dispose failed"));
    const { html } = await open();
    expect(html).toContain(`<p>${CHECKED}</p>`);
  });

  it.each([
    ["the service client cannot be created", () => mocks.createServiceClient.mockImplementation(() => { throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set"); })],
    ["the attempt lookup fails", () => { tables.payment_attempts = () => ({ data: null, error: { message: "relation does not exist" } }); }],
    ["the attempt lookup throws", () => { tables.payment_attempts = () => { throw new Error("network"); }; }],
  ])("answers 200 with confirmation pending when %s", async (_, arrange) => {
    arrange();
    const { res, html } = await open();
    expect(res.status).toBe(200);
    expect(html).toContain(`<p>${PENDING}</p>`);
    expect(mocks.compose).not.toHaveBeenCalled();
  });
});

describe("GET /payment/callback: the operator's name", () => {
  it("names the organization, with the community beneath, beside the check", async () => {
    const { html } = await open();
    expect(html).toContain('<p class="name">Example Organization</p><p class="sub">Example Community</p>');
  });

  it("reads only named columns, never the community's payment settings", async () => {
    await open();
    expect(queries.slice(1)).toEqual([
      { table: "payment_attempts", columns: "community_id", filters: { merchant_reference: REFERENCE } },
      { table: "communities", columns: "name, invoice_config, organizations(name)", filters: { id: COMMUNITY_ID } },
    ]);
    for (const query of queries) {
      expect(query.columns).not.toMatch(/\*|payment_provider|secret/);
    }
  });

  it("prefers the trade name and shows the colour and WhatsApp contact from the invoice branding", async () => {
    tables.communities = communitiesTable({
      seller: { legal_name: "Example Energy Ltd", trade_name: "Example Energy", contact_phone: "0700 000 002" },
      branding: { primary_color: "#163a5f", whatsapp_number: "+256 700 000 001" },
    });
    const { html } = await open();
    expect(html).toContain('<p class="name">Example Energy</p><p class="sub">Example Community</p>');
    expect(html).toContain(".brand{border-top-color:#163a5f}");
    expect(html).toContain("<p>Questions about this payment? Message Example Energy on WhatsApp.</p>");
    expect(html).toContain('href="https://wa.me/256700000001"');
    expect(html).toContain(">WhatsApp +256 700 000 001</a>");
  });

  it("shows the names only when the invoice branding does not parse", async () => {
    tables.communities = communitiesTable({ unknown: true, branding: { primary_color: "#163a5f", whatsapp_number: "0700" } });
    const { html } = await open();
    expect(html).toContain('<p class="name">Example Organization</p><p class="sub">Example Community</p>');
    expect(html).not.toContain("#163a5f");
    expect(html).not.toContain("WhatsApp");
  });

  it("leaves the page unbranded for an attempt with no community", async () => {
    tables.payment_attempts = attemptsTable({ org_id: "org-1", community_id: null });
    const { html } = await open();
    expect(html).toContain(`<p>${CHECKED}</p>`);
    expect(html).not.toContain("<header");
    expect(queries.map((query) => query.table)).not.toContain("communities");
  });

  it.each([
    ["the community read throws", () => { tables.communities = () => { throw new Error("network"); }; }],
    ["the community read fails", () => { tables.communities = () => ({ data: null, error: { message: "timeout" } }); }],
    ["the second attempt read throws", () => {
      let reads = 0;
      const attempts = attemptsTable();
      tables.payment_attempts = (query) => {
        reads += 1;
        if (reads > 1) throw new Error("network");
        return attempts(query);
      };
    }],
  ])("still says the status was checked when %s", async (_, arrange) => {
    arrange();
    const { res, html } = await open();
    expect(res.status).toBe(200);
    expect(html).toContain(`<p>${CHECKED}</p>`);
    expect(html).not.toContain("<header");
  });

  it("still names the operator when the check fails", async () => {
    mocks.handle.mockResolvedValue({ ok: true, data: { processed: false, attemptId: "a" } });
    const { html } = await open();
    expect(html).toContain(`<p>${PENDING}</p>`);
    expect(html).toContain('<p class="name">Example Organization</p>');
  });
});

describe("GET /payment/callback: the operator's logo", () => {
  const withLogo = () => {
    tables.communities = communitiesTable({ branding: { logo_storage_path: `${COMMUNITY_ID}/logo.png` } });
  };

  it("embeds a small PNG from the invoice logo bucket", async () => {
    withLogo();
    const bytes = pngBytes(512);
    mocks.info.mockResolvedValue({ data: { size: 512, contentType: "image/png" }, error: null });
    mocks.download.mockResolvedValue({ data: new Blob([bytes]), error: null });
    const { html } = await open();
    expect(buckets.every((bucket) => bucket === "invoice-logos")).toBe(true);
    expect(mocks.info).toHaveBeenCalledWith(`${COMMUNITY_ID}/logo.png`);
    expect(mocks.download).toHaveBeenCalledWith(`${COMMUNITY_ID}/logo.png`);
    expect(html).toContain(`<img src="data:image/png;base64,${Buffer.from(bytes).toString("base64")}" alt="">`);
  });

  it("reads the size and type from the object's metadata when the storage API puts them there", async () => {
    withLogo();
    mocks.info.mockResolvedValue({ data: { metadata: { size: 512, mimetype: "image/png" } }, error: null });
    mocks.download.mockResolvedValue({ data: new Blob([pngBytes(512)]), error: null });
    const { html } = await open();
    expect(html).toContain('<img src="data:image/png;base64,');
  });

  it.each([
    ["an SVG", { size: 300, contentType: "image/svg+xml" }],
    ["a logo larger than 6 KB", { size: 6145, contentType: "image/png" }],
    ["a logo of unknown size", { contentType: "image/png" }],
    ["a logo of unknown type", { size: 300 }],
  ])("does not download %s", async (_, info) => {
    withLogo();
    mocks.info.mockResolvedValue({ data: info, error: null });
    const { html } = await open();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(html).not.toContain("<img");
    expect(html).toContain('<p class="name">Example Organization</p>');
  });

  it.each([
    ["bytes that are not a PNG or JPEG", () => mocks.download.mockResolvedValue({ data: new Blob(["<svg onload=alert(1)>"]), error: null })],
    ["more bytes than the storage API reported", () => mocks.download.mockResolvedValue({ data: new Blob([pngBytes(6145)]), error: null })],
    ["a download error", () => mocks.download.mockResolvedValue({ data: null, error: new Error("denied") })],
    ["a download that throws", () => mocks.download.mockRejectedValue(new Error("network"))],
  ])("leaves the logo out after %s, and keeps the page", async (_, arrange) => {
    withLogo();
    mocks.info.mockResolvedValue({ data: { size: 300, contentType: "image/png" }, error: null });
    arrange();
    const { res, html } = await open();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<img");
    expect(html).toContain(`<p>${CHECKED}</p>`);
    expect(html).toContain('<p class="name">Example Organization</p>');
  });

  it.each([
    ["an info error", () => mocks.info.mockResolvedValue({ data: null, error: new Error("not found") })],
    ["an info call that throws", () => mocks.info.mockRejectedValue(new Error("network"))],
  ])("leaves the logo out after %s", async (_, arrange) => {
    withLogo();
    arrange();
    const { res, html } = await open();
    expect(res.status).toBe(200);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(html).not.toContain("<img");
    expect(html).toContain(`<p>${CHECKED}</p>`);
  });

  it("stops waiting for the logo after two seconds", async () => {
    vi.useFakeTimers();
    withLogo();
    mocks.info.mockReturnValue(new Promise(() => {}));
    const pending = route.GET(request(RETURN));
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const html = await (await pending).text();
    expect(html).not.toContain("<img");
    expect(html).toContain('<p class="name">Example Organization</p>');
    expect(html).toContain(`<p>${CHECKED}</p>`);
  });

  it("does not look for a logo when the branding names none", async () => {
    await open();
    expect(buckets).toEqual([]);
  });
});

describe("GET /payment/callback: the response", () => {
  it("is an uncached HTML page with the public page security headers and no script", async () => {
    const { res, html } = await open();
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const [name, value] of Object.entries(PUBLIC_PAGE_SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script/i);
  });

  it("shows no amount, reference or tracking id", async () => {
    const { html } = await open();
    expect(html).not.toContain(REFERENCE);
    expect(html).not.toContain(TRACKING);
    expect(html).not.toMatch(/\bpaid\b|UGX|amount/i);
  });

  it.each([
    [null, "en"],
    ["en-UG,en;q=0.9", "en"],
    ["lg-UG,sw;q=0.8", "en"],
  ])("answers Accept-Language %j in %s, and says so", async (header, lang) => {
    const { res, html } = await open(RETURN, header === null ? {} : { "accept-language": header });
    expect(html).toContain(`<html lang="${lang}">`);
    expect(res.headers.get("content-language")).toBe(lang);
    expect(res.headers.get("vary")).toBe("Accept-Language");
  });

  it("exports GET and its dynamic setting only, so other methods are refused", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic"]);
    expect(route.dynamic).toBe("force-dynamic");
  });
});
