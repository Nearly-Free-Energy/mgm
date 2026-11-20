/**
 * The `payments.payment-setup` loader: the period and the microgrid through
 * the person's own client; the community's readiness through the Payments
 * capability's getReadiness, composed after the loader's own reads and
 * always disposed, and shown as not checked, never a refusal, when it
 * cannot be read; refusals with fixed copy, never a database or capability
 * message; and nothing of the merchant account in the model.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf, superAdmin, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import type { SurfaceRequest } from "@/lib/gui/surface";
import type { UserRoleRecord } from "@/lib/types/domain";

const composePayments = vi.fn();
vi.mock("@/lib/payments/compose", () => ({ composePayments: (...args: unknown[]) => composePayments(...args) }));

import { loadPaymentSetup, PAYMENT_SETUP_REFUSALS } from "../payment-setup";
import { COMMUNITY_PAYMENT_LINK, nextStep, PAYMENT_SETUP_COPY } from "../payment-setup-model";

const ORG = "e8400000-0000-4000-8000-000000000001";
const MG = "e8400000-0000-4000-8000-0000000000a1";
const COMMUNITY = "e8400000-0000-4000-8000-0000000000a2";
const PERIOD = "e8400000-0000-4000-8000-0000000000b1";
const SECRET = "permission denied for table microgrids";
const fmt = createFmt({ locale: "en-GB" });
const ACCOUNT = {
  id: "acct-1",
  consumer_key: "consumer-key-canary",
  last_test_message: "provider said no: raw text",
  display_name: "Default Pesapal account",
};

type Fixture = { period?: unknown; microgrid?: unknown; periodError?: boolean; microgridError?: boolean };
function fixture(o: Fixture = {}) {
  return tableClient({
    billing_periods: o.periodError ? { data: null, error: { message: SECRET } } : { data: o.period === undefined ? [{ id: PERIOD }] : o.period },
    microgrids: o.microgridError
      ? { data: null, error: { message: SECRET } }
      : { data: o.microgrid === undefined ? [{ id: MG, community_id: COMMUNITY }] : o.microgrid },
  });
}

const req = (client: SupabaseClient, roles: UserRoleRecord[] = [managerOf(ORG)]): SurfaceRequest =>
  ({
    supabase: client,
    user: { id: "e8400000-0000-4000-8fff-000000000001" } as User,
    roles,
    organizationId: ORG,
    params: { id: MG, periodId: PERIOD },
    search: new URLSearchParams(),
    fmt,
  }) as unknown as SurfaceRequest;

const dispose = vi.fn(async () => {});
const getReadiness = vi.fn();
let order: string[];

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  getReadiness.mockImplementation(async () => ({ ok: true, data: { state: "unconfigured", message: "No Pesapal account configured." } }));
  composePayments.mockImplementation(async () => {
    order.push("compose");
    return { ok: true, data: { payments: { getReadiness }, dispose } };
  });
});

const fields = (out: Awaited<ReturnType<typeof loadPaymentSetup>>) =>
  out.ok ? Object.fromEntries(out.model.body.sections.flatMap((s) => s.fields).map((f) => [f.key, f.value])) : null;

describe("the payment setup loader", () => {
  it("reads the microgrid's community, then its readiness through the capability, and disposes", async () => {
    const { client, calls } = fixture();
    const out = await loadPaymentSetup(req(client, [superAdmin()]));
    expect(out.ok && out.model.title).toBe(PAYMENT_SETUP_COPY.title);
    expect(fields(out)).toEqual({
      status: { t: "status", v: "unconfigured", tone: "warning", text: "Not set up" },
      next: { t: "text", text: nextStep("unconfigured", true) },
    });
    expect(out.ok && out.model.links).toEqual([
      { id: COMMUNITY_PAYMENT_LINK, label: PAYMENT_SETUP_COPY.linkLabel, href: `/communities/${COMMUNITY}/payment` },
    ]);
    expect(calls.find((c) => c.table === "billing_periods")!.ops).toContainEqual(["eq", ["microgrid_id", MG]]);
    expect(calls.find((c) => c.table === "microgrids")!.ops).toContainEqual(["eq", ["id", MG]]);
    expect(composePayments).toHaveBeenCalledWith({ supabase: client, organizationId: ORG, allowDisabled: true });
    expect(getReadiness).toHaveBeenCalledWith(COMMUNITY);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("composes only after its own reads, and reads no payment table itself", async () => {
    const { client, calls } = fixture();
    const from = client.from.bind(client);
    (client as unknown as { from: (t: string) => unknown }).from = (t: string) => (order.push(t), from(t));
    await loadPaymentSetup(req(client));
    expect(order).toEqual(["billing_periods", "microgrids", "compose"]);
    expect(calls.map((c) => c.table).filter((t) => t.startsWith("payment"))).toEqual([]);
    for (const c of calls) for (const [op, args] of c.ops) if (op === "select") expect(String(args[0])).not.toContain("*");
  });

  it("tells an organization manager to ask a super admin, with no link", async () => {
    const out = await loadPaymentSetup(req(fixture().client));
    expect(fields(out)?.next).toEqual({ t: "text", text: `${PAYMENT_SETUP_COPY.unconfigured} ${PAYMENT_SETUP_COPY.ask}` });
    expect(out.ok && out.model.links).toEqual([]);
  });

  it.each(["ready", "sandbox", "disabled", "connection_error"] as const)("shows the capability's %s state", async (state) => {
    getReadiness.mockResolvedValue({ ok: true, data: { state, message: "capability copy", account: ACCOUNT } });
    const out = await loadPaymentSetup(req(fixture().client));
    expect(fields(out)?.status).toMatchObject({ t: "status", v: state });
    expect(fields(out)?.next).toEqual({ t: "text", text: nextStep(state, false) });
    // Fixed copy only: nothing of the account or the capability's message.
    const text = JSON.stringify(out);
    for (const s of ["capability copy", ACCOUNT.consumer_key, ACCOUNT.last_test_message, ACCOUNT.id, ACCOUNT.display_name]) expect(text).not.toContain(s);
  });

  it.each([
    ["a composition the session refuses", () => composePayments.mockResolvedValue({ ok: false, status: 401, code: "x", message: "secret" })],
    ["a composition that fails", () => composePayments.mockResolvedValue({ ok: false, status: 500, code: "x", message: "Could not compose payments: secret" })],
    ["a composition that throws", () => composePayments.mockRejectedValue(new Error("secret"))],
    ["a refused readiness", () => getReadiness.mockResolvedValue({ ok: false, status: 503, code: "payments_unavailable", message: "secret" })],
    ["a readiness that throws", () => getReadiness.mockRejectedValue(new Error("secret"))],
    ["a state it does not know", () => getReadiness.mockResolvedValue({ ok: true, data: { state: "suspended", message: "secret" } })],
  ])("shows %s as not checked, never as a refusal", async (_label, arrange) => {
    arrange();
    const out = await loadPaymentSetup(req(fixture().client));
    expect(fields(out)).toEqual({
      status: { t: "status", v: "unchecked", tone: "neutral", text: "Not checked" },
      next: { t: "text", text: PAYMENT_SETUP_COPY.unchecked },
    });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("disposes the composition when getReadiness throws", async () => {
    getReadiness.mockRejectedValue(new Error("secret"));
    await loadPaymentSetup(req(fixture().client));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("is not found for a period under another microgrid, or a microgrid not seen, composing nothing", async () => {
    expect(await loadPaymentSetup(req(fixture({ period: [] }).client))).toEqual(PAYMENT_SETUP_REFUSALS.notFound);
    expect(await loadPaymentSetup(req(fixture({ microgrid: [] }).client))).toEqual(PAYMENT_SETUP_REFUSALS.notFound);
    expect(composePayments).not.toHaveBeenCalled();
  });

  it.each([[{ periodError: true }], [{ microgridError: true }]])("is unavailable, with fixed copy, when %o", async (o) => {
    const out = await loadPaymentSetup(req(fixture(o).client));
    expect(out).toEqual(PAYMENT_SETUP_REFUSALS.unavailable);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(composePayments).not.toHaveBeenCalled();
  });
});
