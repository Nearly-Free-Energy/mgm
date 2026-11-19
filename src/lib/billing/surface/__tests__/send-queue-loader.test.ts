/**
 * The `billing.send-queue` loader: the period, the microgrid, the tenants
 * and the bills through the person's own client; the community's payment
 * readiness through composePayments, only when there are bills, and never a
 * refusal of the view when it cannot be read; each link from
 * stablePaymentLinkPath and MGM_APP_URL; refusals with fixed copy, never a
 * database message; and no tenant's email or phone in the model.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf, superAdmin, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { SurfaceRequest } from "@/lib/gui/surface";
import type { UserRoleRecord } from "@/lib/types/domain";

const composePayments = vi.fn();
vi.mock("@/lib/payments/compose", async () => {
  const { appUrl } = await import("@/lib/config/app-url");
  return { composePayments: (...args: unknown[]) => composePayments(...args), defaultAppUrl: (path: string) => appUrl(path) };
});

import { loadSendQueue, SEND_QUEUE_REFUSALS } from "../send-queue";
import { buildSendQueueModel, SEND_QUEUE_COPY, SEND_QUEUE_SUBTITLES } from "../send-queue-model";

const ORG = "e8100000-0000-4000-8000-000000000001";
const MG = "e8100000-0000-4000-8000-0000000000a1";
const COMMUNITY = "e8100000-0000-4000-8000-0000000000a2";
const PERIOD = "e8100000-0000-4000-8000-0000000000b1";
const T1 = "e8100000-0000-4000-8000-0000000000c1";
const T2 = "e8100000-0000-4000-8000-0000000000c2";
const T3 = "e8100000-0000-4000-8000-0000000000c3";
const B1 = "e8100000-0000-4000-8000-0000000000d1";
const B2 = "e8100000-0000-4000-8000-0000000000d2";
const B3 = "e8100000-0000-4000-8000-0000000000d3";
const ORIGIN = "https://mgm.example.org";
const SECRET = "permission denied for table billing_line_items";
const EMAIL = "akello@example.org";
const PHONE = "+256700000123";
const fmt = createFmt({ locale: "en-GB" });

const PERIOD_ROW = {
  id: PERIOD,
  microgrid_id: MG,
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  status: "draft",
  timezone: "Africa/Kampala",
  rate_schedule_id: "e8100000-0000-4000-8000-0000000000e1",
};
const MICROGRID = { id: MG, name: "North site", currency: "UGX", community_id: COMMUNITY };
const TENANTS = [
  { id: T1, display_name: "Akello", primary_email: EMAIL, primary_phone: null },
  { id: T2, display_name: "Byaruhanga", primary_email: "", primary_phone: PHONE },
  // Blanks are no contact: ensureCheckout tests the contact as present or not.
  { id: T3, display_name: "Kato", primary_email: "", primary_phone: null },
];
const BILLS = [
  { id: B1, tenant_id: T1, total_amount: "2500", payment_status: "unpaid", invoice_number: null },
  { id: B2, tenant_id: T2, total_amount: 3000, payment_status: "link_generated", invoice_number: "INV-2" },
  { id: B3, tenant_id: T3, total_amount: 1000, payment_status: "unpaid", invoice_number: null },
];

type Fixture = { period?: unknown; microgrid?: unknown; tenants?: unknown; bills?: unknown; periodError?: boolean; billsError?: boolean };
function fixture(o: Fixture = {}) {
  return tableClient({
    billing_periods: o.periodError ? { data: null, error: { message: SECRET } } : { data: o.period === undefined ? [PERIOD_ROW] : o.period },
    microgrids: { data: o.microgrid === undefined ? [MICROGRID] : o.microgrid },
    tenants: { data: o.tenants === undefined ? TENANTS : o.tenants },
    billing_line_items: o.billsError ? { data: null, error: { message: SECRET } } : { data: o.bills === undefined ? BILLS : o.bills },
  });
}

const req = (client: SupabaseClient, roles: UserRoleRecord[] = [managerOf(ORG)]): SurfaceRequest =>
  ({
    supabase: client,
    user: { id: "e8100000-0000-4000-8fff-000000000001" } as User,
    roles,
    organizationId: ORG,
    params: { id: MG, periodId: PERIOD },
    search: new URLSearchParams(),
    fmt,
  }) as unknown as SurfaceRequest;

const dispose = vi.fn(async () => {});
const getReadiness = vi.fn();
/** composePayments answering `state`, or the result `answer` gives. */
function payments(state: string | (() => unknown)) {
  getReadiness.mockImplementation(async () => (typeof state === "function" ? state() : { ok: true, data: { state, message: "secret detail from the account" } }));
  composePayments.mockResolvedValue({ ok: true, data: { payments: { getReadiness }, dispose } });
}

const urls = (model: { ext?: { data: unknown } }) => (model.ext!.data as { rows: { id: string; url: string | null }[] }).rows;

beforeEach(() => {
  composePayments.mockReset();
  getReadiness.mockReset();
  dispose.mockClear();
  vi.stubEnv("MGM_APP_URL", ORIGIN);
});
afterEach(() => vi.unstubAllEnvs());

describe("loadSendQueue", () => {
  it("reads the period on its microgrid, the microgrid, the bills and the tenants through the person's client", async () => {
    payments("ready");
    const { client, calls } = fixture();
    const out = await loadSendQueue(req(client));
    expect(out.ok).toBe(true);
    expect(calls).toEqual([
      {
        table: "billing_periods",
        ops: [
          ["select", ["id, microgrid_id, start_date, end_date, status, timezone, rate_schedule_id"]],
          ["eq", ["id", PERIOD]],
          ["eq", ["microgrid_id", MG]],
          ["maybeSingle", []],
        ],
      },
      { table: "microgrids", ops: [["select", ["id, name, currency, community_id"]], ["eq", ["id", MG]], ["maybeSingle", []]] },
      {
        table: "billing_line_items",
        ops: [
          ["select", ["id, tenant_id, total_amount, payment_status, invoice_number", { count: "exact" }]],
          ["eq", ["billing_period_id", PERIOD]],
          ["order", ["id"]],
          ["limit", [1000]],
        ],
      },
      {
        table: "tenants",
        ops: [
          ["select", ["id, display_name, primary_email, primary_phone", { count: "exact" }]],
          ["eq", ["microgrid_id", MG]],
          ["order", ["display_name"]],
          ["order", ["id"]],
          ["range", [0, 999]],
        ],
      },
    ]);
    // Readiness through the same client, with disabled plugins still readable, for the microgrid's community.
    expect(composePayments).toHaveBeenCalledWith({ supabase: client, organizationId: ORG, allowDisabled: true });
    expect(getReadiness).toHaveBeenCalledWith(COMMUNITY);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("builds each link from MGM_APP_URL and the stable path, and derives contact without passing it on", async () => {
    payments("ready");
    const out = await loadSendQueue(req(fixture().client));
    if (!out.ok) throw new Error(out.message);
    expect(urls(out.model)).toEqual([
      { id: B1, url: `${ORIGIN}/api/billing-line-items/${B1}/pay` },
      { id: B2, url: `${ORIGIN}/api/billing-line-items/${B2}/pay` },
      // Kato has only blanks.
      { id: B3, url: null },
    ]);
    expect(out.model.body.rows[2].cells.note).toEqual(fmt.text(SEND_QUEUE_COPY.noContact));
    expect(out.model).toEqual(
      buildSendQueueModel({
        microgrid: { id: MG, name: "North site", currency: "UGX" },
        period: PERIOD_ROW as never,
        tenants: [
          { id: T1, display_name: "Akello", hasContact: true },
          { id: T2, display_name: "Byaruhanga", hasContact: true },
          { id: T3, display_name: "Kato", hasContact: false },
        ],
        bills: BILLS.map((b) => ({ ...b, total_amount: Number(b.total_amount) })) as never,
        readiness: "ready",
        linkFor: (id) => `${ORIGIN}/api/billing-line-items/${id}/pay`,
        superAdmin: false,
        fmt,
      }),
    );
    const json = JSON.stringify(out.model);
    expect(json).not.toContain(EMAIL);
    expect(json).not.toContain(PHONE);
    // getReadiness's own message is never passed on.
    expect(json).not.toContain("secret detail");
  });

  it.each([
    ["the period is not found", { period: [] }, SEND_QUEUE_REFUSALS.notFound],
    ["the microgrid is not found", { microgrid: [] }, SEND_QUEUE_REFUSALS.notFound],
    ["the period read fails", { periodError: true }, SEND_QUEUE_REFUSALS.unavailable],
    ["the bills read fails", { billsError: true }, SEND_QUEUE_REFUSALS.unavailable],
    ["the period has no tariff", { period: [{ ...PERIOD_ROW, rate_schedule_id: null }] }, SEND_QUEUE_REFUSALS.noTariff],
  ] as const)("refuses with fixed copy when %s", async (_label, o, refusal) => {
    payments("ready");
    const out = await loadSendQueue(req(fixture(o as Fixture).client));
    expect(out).toEqual(refusal);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("finds a period only under the microgrid of the path", async () => {
    payments("ready");
    const { client, calls } = fixture({ period: [] });
    expect(await loadSendQueue(req(client))).toEqual(SEND_QUEUE_REFUSALS.notFound);
    expect(calls[0].ops).toContainEqual(["eq", ["microgrid_id", MG]]);
  });

  it("refuses more bills than the view can show, rather than cutting them", async () => {
    payments("ready");
    const tenants = Array.from({ length: 501 }, (_, n) => ({ id: `t-${n}`, display_name: `T${n}`, primary_email: null, primary_phone: PHONE }));
    const bills = tenants.map((t, n) => ({ id: `b-${String(n).padStart(4, "0")}`, tenant_id: t.id, total_amount: 1, payment_status: "unpaid", invoice_number: null }));
    expect(await loadSendQueue(req(fixture({ tenants, bills }).client))).toEqual(SEND_QUEUE_REFUSALS.tooLarge);
  });

  it("does not read readiness with no bills, shows the empty state, and says nothing about online payments", async () => {
    payments("ready");
    const out = await loadSendQueue(req(fixture({ bills: [] }).client));
    if (!out.ok) throw new Error(out.message);
    expect(composePayments).not.toHaveBeenCalled();
    expect(out.model.body.rows).toEqual([]);
    expect(out.model.body.empty.title).toBe("No bills to send yet.");
    // Not the "could not check" warning: nothing failed, there is just nothing to send.
    expect(out.model.subtitle).toBe("Africa/Kampala");
    expect((out.model.ext!.data as { note: unknown }).note).toBeNull();
  });

  it.each([
    ["composition is refused", () => composePayments.mockResolvedValue({ ok: false, status: 403, code: "payments_forbidden", message: "x" }), false],
    ["composition throws", () => composePayments.mockRejectedValue(new Error("SUPABASE_SERVICE_ROLE_KEY missing")), false],
    ["readiness is refused", () => payments(() => ({ ok: false, status: 500, code: "payments_unavailable", message: SECRET })), true],
    ["readiness throws", () => payments(() => Promise.reject(new Error(SECRET))), true],
    ["readiness answers an unknown state", () => payments("brand_new"), true],
  ])("shows no links, as not checked, when %s, and disposes what it composed", async (_label, arrange, composed) => {
    arrange();
    const out = await loadSendQueue(req(fixture().client));
    if (!out.ok) throw new Error(out.message);
    expect(urls(out.model).every((r) => r.url === null)).toBe(true);
    expect(out.model.subtitle).toBe(SEND_QUEUE_SUBTITLES.unchecked);
    expect((out.model.ext!.data as { note: unknown }).note).toEqual({ tone: "warning", text: SEND_QUEUE_COPY.unchecked });
    expect(dispose).toHaveBeenCalledTimes(composed ? 1 : 0);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it.each(["", "not a url", "http://mgm.example.org"])("says the installation has no address when MGM_APP_URL is %j", async (value) => {
    vi.stubEnv("MGM_APP_URL", value);
    payments("ready");
    const out = await loadSendQueue(req(fixture().client));
    if (!out.ok) throw new Error(out.message);
    expect(urls(out.model).every((r) => r.url === null)).toBe(true);
    expect(out.model.subtitle).toBe(SEND_QUEUE_SUBTITLES.no_address);
    expect((out.model.ext!.data as { note: { text: string } }).note.text).toBe(SEND_QUEUE_COPY.noAddress);
  });

  it.each(["disabled", "unconfigured", "connection_error"] as const)("shows no links while readiness is %s", async (state) => {
    payments(state);
    const out = await loadSendQueue(req(fixture().client));
    if (!out.ok) throw new Error(out.message);
    expect(urls(out.model).every((r) => r.url === null)).toBe(true);
    expect(out.model.subtitle).toBe(SEND_QUEUE_SUBTITLES[state]);
  });

  it("shows links from a sandbox account, and tells a super admin how to connect a provider", async () => {
    payments("sandbox");
    const sandbox = await loadSendQueue(req(fixture().client));
    if (!sandbox.ok) throw new Error(sandbox.message);
    expect(urls(sandbox.model)[0].url).toBe(`${ORIGIN}/api/billing-line-items/${B1}/pay`);
    expect(sandbox.model.subtitle).toBe(SEND_QUEUE_SUBTITLES.sandbox);

    payments("unconfigured");
    const admin = await loadSendQueue(req(fixture().client, [superAdmin()]));
    if (!admin.ok) throw new Error(admin.message);
    expect((admin.model.ext!.data as { note: { text: string } }).note.text).toContain(SEND_QUEUE_COPY.superAdminFix);
  });
});
