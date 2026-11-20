/**
 * The availability and confirmation steps of the reconciliations the
 * `payments.bill-attempts` view offers: available() answers
 * reconcileReason for each attempt the person's client shows, after one
 * composition; prepare reads the attempt, its tenant and the bill's history
 * and returns the step, the tenant's name typed for a completed adjustment,
 * or refuses with fixed copy. Neither writes, nor calls a route.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import { cleanPrefill } from "@/lib/gui/host/server/merge";
import type { SurfaceRequest } from "@/lib/gui/surface";

const composePayments = vi.fn();
vi.mock("@/lib/payments/compose", () => ({ composePayments: (...args: unknown[]) => composePayments(...args) }));

import { RECONCILE_COPY } from "../../schemas";
import { PAYMENTS_SURFACE } from "../../surface";
import { ATTEMPT_REFUSALS, prepareAcceptReceipts, prepareRecordAdjustment, reconcileAvailable } from "../bill-attempts";

const ORG = "e8400000-0000-4000-8000-000000000001";
const B1 = "e8400000-0000-4000-8000-0000000000d1";
const A1 = "e8400000-0000-4000-8000-0000000000e1";
const A2 = "e8400000-0000-4000-8000-0000000000e2";
const fmt = createFmt({ locale: "en-GB" });

const rawAttempt = (o: Record<string, unknown> = {}) => ({
  id: A1,
  line_item_id: B1,
  status: "needs_reconciliation",
  amount: 5000,
  currency: "UGX",
  merchant_reference: `MGM-${A1}`,
  provider_tracking_id: "track",
  failure_code: "balance_mismatch",
  failure_message: null,
  checkout_url: null,
  created_at: "2026-10-03T09:15:00Z",
  ...o,
});
const receipt = (amount: number, currency = "UGX") => ({
  id: `r-${amount}-${currency}`,
  attempt_id: A1,
  amount,
  currency,
  provider_status: "completed",
  provider_tracking_id: "track",
  confirmation_code: null,
  payment_method: null,
  created_at: "2026-10-03T09:20:00Z",
});
const history = (o: { attempts?: unknown[]; receipts?: unknown[]; received?: number } = {}) => {
  const received = o.received ?? 3000;
  return { ok: true, data: { attempts: o.attempts ?? [rawAttempt()], receipts: o.receipts ?? [receipt(received)], currentTotal: 5000, currency: "UGX", received, difference: received - 5000 } };
};

const dispose = vi.fn(async () => {});
const listHistory = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  listHistory.mockResolvedValue(history());
  composePayments.mockResolvedValue({ ok: true, data: { payments: { listHistory }, dispose } });
});

function client(o: { attempts?: unknown; bill?: unknown; attemptsError?: boolean } = {}) {
  return tableClient({
    payment_attempts: o.attemptsError ? { data: null, error: { message: "secret" } } : { data: o.attempts === undefined ? [rawAttempt()] : o.attempts },
    billing_line_items: { data: o.bill === undefined ? [{ id: B1, tenants: { display_name: "  Akello Grace " } }] : o.bill },
  });
}
const req = (c: SupabaseClient): SurfaceRequest =>
  ({ supabase: c, user: { id: "u" } as User, roles: [managerOf(ORG)], organizationId: ORG, params: {}, search: new URLSearchParams(), fmt }) as unknown as SurfaceRequest;

describe("reconcileAvailable", () => {
  it("allows recording the difference and refuses accepting receipts that fall short", async () => {
    const c = client();
    expect(await reconcileAvailable("record")(req(c.client), [A1])).toEqual({ [A1]: true });
    expect(await reconcileAvailable("accept")(req(c.client), [A1])).toEqual({ [A1]: RECONCILE_COPY.notExact });
    expect(composePayments).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(c.calls[0].ops).toContainEqual(["select", ["id, line_item_id"]]);
  });

  it("allows accepting receipts that come to the bill", async () => {
    listHistory.mockResolvedValue(history({ received: 5000 }));
    expect(await reconcileAvailable("accept")(req(client().client), [A1])).toEqual({ [A1]: true });
  });

  it.each([
    ["an attempt that needs none", history({ attempts: [rawAttempt({ status: "verified" })] }), RECONCILE_COPY.notNeeded],
    ["an unknown outcome on the bill", history({ attempts: [rawAttempt(), rawAttempt({ id: A2, status: "pending", provider_tracking_id: null })] }), RECONCILE_COPY.unknownOutcome],
    ["mixed currencies", history({ receipts: [receipt(5000), receipt(1, "USD")], received: 5000 }), RECONCILE_COPY.mixed],
  ])("refuses %s for both", async (_label, answer, reason) => {
    listHistory.mockResolvedValue(answer);
    expect(await reconcileAvailable("record")(req(client().client), [A1])).toEqual({ [A1]: reason });
    expect(await reconcileAvailable("accept")(req(client().client), [A1])).toEqual({ [A1]: reason });
  });

  it("says an attempt the person's client does not show is not found, composing nothing for it", async () => {
    expect(await reconcileAvailable("record")(req(client({ attempts: [] }).client), [A1, "not-a-uuid"])).toEqual({
      [A1]: ATTEMPT_REFUSALS.notFound.message,
      "not-a-uuid": ATTEMPT_REFUSALS.notFound.message,
    });
    expect(composePayments).not.toHaveBeenCalled();
  });

  it("refuses recording an adjustment for a tenant with no name, as prepare and the capability do, and still allows accepting", async () => {
    listHistory.mockResolvedValue(history({ received: 5000 }));
    const blank = () => client({ bill: [{ id: B1, tenants: { display_name: "  " } }] });
    expect(await reconcileAvailable("record")(req(blank().client), [A1])).toEqual({ [A1]: ATTEMPT_REFUSALS.noName.message });
    expect(await reconcileAvailable("accept")(req(blank().client), [A1])).toEqual({ [A1]: true });
    expect(await prepareRecordAdjustment(req(blank().client), { params: { id: A1 } })).toEqual(ATTEMPT_REFUSALS.noName);
  });

  it("says a completed adjustment on a bill the person's client does not show is not found", async () => {
    expect(await reconcileAvailable("record")(req(client({ bill: [] }).client), [A1])).toEqual({ [A1]: ATTEMPT_REFUSALS.notFound.message });
  });

  it("reads each bill's history once", async () => {
    const c = client({ attempts: [rawAttempt(), rawAttempt({ id: A2 })] });
    await reconcileAvailable("record")(req(c.client), [A1, A2]);
    expect(listHistory).toHaveBeenCalledTimes(1);
  });

  it("throws when the attempts, the bills or the composition cannot be read, so the host shows it unchecked", async () => {
    await expect(reconcileAvailable("record")(req(client({ attemptsError: true }).client), [A1])).rejects.toThrow();
    const billsError = tableClient({ payment_attempts: { data: [rawAttempt()] }, billing_line_items: { data: null, error: { message: "secret" } } });
    await expect(reconcileAvailable("record")(req(billsError.client), [A1])).rejects.toThrow();
    composePayments.mockResolvedValue({ ok: false, status: 500, code: "x", message: "secret" });
    await expect(reconcileAvailable("record")(req(client().client), [A1])).rejects.toThrow();
  });
});

describe("prepareRecordAdjustment", () => {
  it("asks for the tenant's name, trimmed, and names the amount that settles the bill", async () => {
    const out = await prepareRecordAdjustment(req(client().client), { params: { id: A1 } });
    expect(out).toEqual({
      ok: true,
      model: {
        type: "ceremony",
        statement: "Record a collection or refund completed outside MGM for Akello Grace's bill, which is then marked paid. MGM moves no money here.",
        facts: [
          { label: "Current bill", value: fmt.money(5000, "UGX") },
          { label: "Received", value: fmt.money(3000, "UGX") },
          { label: "Difference", value: fmt.money(-2000, "UGX") },
          { label: "This attempt", value: fmt.money(5000, "UGX") },
          { label: "Reference", value: fmt.text(`MGM-${A1}`) },
        ],
        warnings: [`Enter ${fmt.money(2000, "UGX").text} as the external amount (negative for a refund): the received total must come to exactly the current bill.`],
        acknowledgements: [],
        typed: "Akello Grace",
      },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("names a negative amount for a refund", async () => {
    listHistory.mockResolvedValue(history({ received: 6000 }));
    const out = await prepareRecordAdjustment(req(client().client), { params: { id: A1 } });
    expect(out.ok && out.model.warnings[0]).toContain(fmt.money(-1000, "UGX").text);
  });

  it.each([
    ["an id that is not a UUID", { id: "x" }, client(), ATTEMPT_REFUSALS.notFound],
    ["an attempt the client does not show", { id: A1 }, client({ attempts: [] }), ATTEMPT_REFUSALS.notFound],
    ["a bill the client does not show", { id: A1 }, client({ bill: [] }), ATTEMPT_REFUSALS.notFound],
    ["an attempt that cannot be read", { id: A1 }, client({ attemptsError: true }), ATTEMPT_REFUSALS.unavailable],
    ["a tenant with no name", { id: A1 }, client({ bill: [{ id: B1, tenants: { display_name: "  " } }] }), ATTEMPT_REFUSALS.noName],
  ])("refuses %s with fixed copy", async (_label, params, c, refusal) => {
    expect(await prepareRecordAdjustment(req(c.client), { params })).toEqual(refusal);
  });

  it("refuses an attempt that needs no reconciliation, and an unknown outcome", async () => {
    listHistory.mockResolvedValue(history({ attempts: [rawAttempt({ status: "resolved" })] }));
    expect(await prepareRecordAdjustment(req(client().client), { params: { id: A1 } })).toEqual({ ok: false, status: 409, message: RECONCILE_COPY.notNeeded });
    listHistory.mockResolvedValue(history({ attempts: [rawAttempt({ provider_tracking_id: null })] }));
    expect(await prepareRecordAdjustment(req(client().client), { params: { id: A1 } })).toEqual({ ok: false, status: 409, message: RECONCILE_COPY.unknownOutcome });
  });

  it("refuses with fixed copy when the history cannot be read", async () => {
    listHistory.mockResolvedValue({ ok: false, status: 404, code: "x", message: "secret" });
    expect(await prepareRecordAdjustment(req(client().client), { params: { id: A1 } })).toEqual(ATTEMPT_REFUSALS.notFound);
    composePayments.mockResolvedValue({ ok: false, status: 403, code: "x", message: "secret" });
    expect(await prepareRecordAdjustment(req(client().client), { params: { id: A1 } })).toEqual(ATTEMPT_REFUSALS.forbidden);
  });
});

describe("prepareAcceptReceipts", () => {
  it("confirms the balance when it is exact, with no typed name", async () => {
    listHistory.mockResolvedValue(history({ received: 5000 }));
    const out = await prepareAcceptReceipts(req(client().client), { params: { id: A1 } });
    expect(out).toEqual({
      ok: true,
      model: {
        type: "ceremony",
        statement: "Accept the verified receipts as settling Akello Grace's bill, which is then marked paid.",
        facts: [
          { label: "Current bill", value: fmt.money(5000, "UGX") },
          { label: "Received", value: fmt.money(5000, "UGX") },
          { label: "Difference", value: fmt.money(0, "UGX") },
        ],
        warnings: [],
        acknowledgements: [],
      },
    });
  });

  it("refuses receipts that are not exact", async () => {
    expect(await prepareAcceptReceipts(req(client().client), { params: { id: A1 } })).toEqual({ ok: false, status: 409, message: RECONCILE_COPY.notExact });
  });
});

describe("the contributed actions", () => {
  const def = (id: string) => PAYMENTS_SURFACE.actions!.find((a) => a.id === id)!;

  it("keep each reconciliation's prefill through the host's cleaning", () => {
    expect(cleanPrefill(def("payments.record-adjustment"), { action: "record_external" })).toEqual({ action: "record_external" });
    expect(cleanPrefill(def("payments.accept-receipts"), { action: "accept_exact" })).toEqual({ action: "accept_exact" });
  });

  it("are human-only and offered only where the view links them", () => {
    for (const a of PAYMENTS_SURFACE.actions!) expect([a.humanOnly, a.targeted]).toEqual([true, false]);
  });
});
