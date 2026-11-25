/**
 * The payments watchers: the attempts come from the capability's
 * listAttention after composePayments, the bills through the person's own
 * client; one signal per period with fixed copy and no tenant, amount,
 * reference or provider detail; a link to the bill when only one is
 * concerned; reconciliation critical only when an attempt in the period
 * reached the provider; settled bills and bills held for reconciliation left
 * out of failures; checkouts never submitted reported per community from
 * three in a day, and a truncated listing of them throws; any refusal or
 * failed read throws; the composition is always disposed.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFmt } from "@/lib/gui/fmt";
import { managerOf, tableClient } from "@/lib/gui/host/server/__tests__/host-fakes";
import { signalOutSchema } from "@/lib/gui/host/server/model-schema";
import { MAX_SIGNALS_PER_SOURCE, type SurfaceRequest } from "@/lib/gui/surface";

const composePayments = vi.fn();
vi.mock("@/lib/payments/compose", () => ({ composePayments: (...args: unknown[]) => composePayments(...args) }));

import type { AttentionAttempt } from "../../repository";
import { loadFailedSignals, loadNotSubmittedSignals, loadReconcileSignals } from "../attention-signals";
import { FAILED_EXAMPLES, NOT_SUBMITTED_EXAMPLES, RECONCILE_EXAMPLES } from "../attention-signals-examples";
import {
  buildFailedSignals,
  buildNotSubmittedSignals,
  buildReconcileSignals,
  NOT_SUBMITTED_THRESHOLD,
  type AttentionBill,
} from "../attention-signals-model";

const ORG = "e7f30000-0000-4000-8000-000000000001";
const MG = "e7f30000-0000-4000-8000-0000000000a1";
const OCT = "e7f30000-0000-4000-8000-0000000000b1";
const NOV = "e7f30000-0000-4000-8000-0000000000b2";
const COMMUNITY = "e7f30000-0000-4000-8000-0000000000f1";
const OTHER_COMMUNITY = "e7f30000-0000-4000-8000-0000000000f2";
const bill = (n: number) => `e7f30000-0000-4000-8000-0000000000c${n}`;
const NOW = new Date("2026-11-20T09:00:00Z");
const SECRET = "permission denied for table billing_line_items";
const fmt = createFmt({ locale: "en-GB" });

const attempt = (
  n: number,
  billN: number,
  status: AttentionAttempt["status"],
  updatedAt = "2026-11-19T08:00:00Z",
  o: Partial<AttentionAttempt> = {},
): AttentionAttempt => ({
  id: `e7f30000-0000-4000-8000-0000000000d${n}`,
  lineItemId: bill(billN),
  status,
  failureCode: "balance_mismatch",
  updatedAt,
  communityId: COMMUNITY,
  reachedProvider: true,
  ...o,
});
const notSubmitted = (n: number, communityId: string | null, updatedAt = "2026-11-20T08:00:00Z") =>
  attempt(n, 1, "failed", updatedAt, { failureCode: "checkout_not_submitted", communityId, reachedProvider: false });
const billRow = (n: number, period: string, o: { status?: string; start?: string; end?: string } = {}) => ({
  id: bill(n),
  payment_status: o.status ?? "unpaid",
  billing_periods: { id: period, start_date: o.start ?? "2026-10-01", end_date: o.end ?? "2026-10-31", microgrid_id: MG, microgrids: { id: MG, name: "North site" } },
  tenants: { display_name: "Akello Grace" },
});

let listAttention: ReturnType<typeof vi.fn>;
let dispose: ReturnType<typeof vi.fn>;
/** Answers by status, or by failure code when the query names one; `truncated` says so for every listing. */
function composeWith(answers: Record<string, AttentionAttempt[] | { ok: false; status: number }>, truncated = false) {
  listAttention = vi.fn(async (q: { status: string; failureCode?: string }) => {
    const a = answers[q.failureCode ?? q.status] ?? [];
    return Array.isArray(a) ? { ok: true, data: { attempts: a, truncated } } : { ...a, code: "x", message: SECRET };
  });
  dispose = vi.fn(async () => {});
  composePayments.mockResolvedValue({ ok: true, data: { payments: { listAttention }, dispose } });
}

const req = (client: SupabaseClient): SurfaceRequest =>
  ({
    supabase: client,
    user: { id: "e7f30000-0000-4000-8fff-000000000001" } as User,
    roles: [managerOf(ORG)],
    organizationId: ORG,
    params: {},
    search: new URLSearchParams(),
    locale: "en-GB",
    now: NOW,
    fmt,
  }) as unknown as SurfaceRequest;

beforeEach(() => composePayments.mockReset());

describe("loadReconcileSignals", () => {
  it("composes on the person's client, lists held attempts, reads their bills, and disposes", async () => {
    composeWith({ needs_reconciliation: [attempt(1, 1, "needs_reconciliation", "2026-11-18T10:00:00Z"), attempt(2, 2, "needs_reconciliation")] });
    const { client, calls } = tableClient({ billing_line_items: { data: [billRow(1, OCT), billRow(2, OCT)] } });
    const out = await loadReconcileSignals(req(client));
    expect(composePayments).toHaveBeenCalledWith({ supabase: client, organizationId: ORG });
    expect(listAttention.mock.calls).toEqual([[{ status: "needs_reconciliation" }]]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      {
        table: "billing_line_items",
        ops: [
          ["select", ["id, payment_status, billing_periods!inner(id, start_date, end_date, microgrid_id, microgrids!inner(id, name))"]],
          ["in", ["id", [bill(1), bill(2)]]],
        ],
      },
    ]);
    expect(out).toEqual([
      {
        id: OCT,
        kind: "your-move",
        severity: "critical",
        title: "North site: 2 payments in October 2026 need reconciliation",
        facts: [{ t: "text", text: "1 Oct 2026 – 31 Oct 2026" }],
        entity: { kind: "microgrid", id: MG, label: "North site" },
        href: `/microgrids/${MG}/billing/${OCT}/payments`,
        at: "2026-11-19T08:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("Akello");
  });

  it("links to the bill when only one is concerned, and reads nothing when nothing is held", async () => {
    composeWith({ needs_reconciliation: [attempt(1, 1, "needs_reconciliation")] });
    const { client } = tableClient({ billing_line_items: { data: [billRow(1, OCT)] } });
    const [one] = await loadReconcileSignals(req(client));
    expect([one.title, one.href]).toEqual([
      "North site: 1 payment in October 2026 needs reconciliation",
      `/microgrids/${MG}/billing/${OCT}/payments?bill=${bill(1)}`,
    ]);

    composeWith({});
    const empty = tableClient({});
    expect(await loadReconcileSignals(req(empty.client))).toEqual([]);
    expect(empty.calls).toEqual([]);
  });

  it("throws, without the refusal's message, when composing or listing is refused, and still disposes", async () => {
    composePayments.mockResolvedValue({ ok: false, status: 403, code: "forbidden", message: SECRET });
    const { client } = tableClient({});
    await expect(loadReconcileSignals(req(client))).rejects.toThrow("payments watcher: the capability could not be composed (403)");

    composeWith({ needs_reconciliation: { ok: false, status: 400 } });
    const listing = loadReconcileSignals(req(client));
    await expect(listing).rejects.toThrow("payments watcher: listAttention refused (400)");
    await expect(listing).rejects.not.toThrow(SECRET);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("throws on a failed bills read, without the database's message", async () => {
    composeWith({ needs_reconciliation: [attempt(1, 1, "needs_reconciliation")] });
    const { client } = tableClient({ billing_line_items: { data: null, error: { message: SECRET } } });
    const failed = loadReconcileSignals(req(client));
    await expect(failed).rejects.toThrow("payments watcher: the bills could not be read");
    await expect(failed).rejects.not.toThrow(SECRET);
  });

  it("makes it a warning when no held attempt in the period reached the provider, and critical when any did", async () => {
    const neither = [attempt(1, 1, "needs_reconciliation", undefined, { failureCode: "bill_revised", reachedProvider: false }), attempt(2, 2, "needs_reconciliation", undefined, { reachedProvider: false })];
    composeWith({ needs_reconciliation: neither });
    const { client } = tableClient({ billing_line_items: { data: [billRow(1, OCT), billRow(2, OCT)] } });
    expect((await loadReconcileSignals(req(client))).map((s) => [s.severity, s.title])).toEqual([
      ["warn", "North site: 2 checkouts in October 2026 need reconciliation"],
    ]);

    composeWith({ needs_reconciliation: [neither[0], { ...neither[1], reachedProvider: true }] });
    expect((await loadReconcileSignals(req(client))).map((s) => [s.severity, s.title])).toEqual([
      ["critical", "North site: 2 payments in October 2026 need reconciliation"],
    ]);
  });

  it("reads the bills in chunks of 100", async () => {
    composeWith({ needs_reconciliation: Array.from({ length: 250 }, (_, i) => ({ ...attempt(1, 1, "needs_reconciliation"), id: `a${i}`, lineItemId: `b${i}` })) });
    const { client, calls } = tableClient({ billing_line_items: { data: [] } });
    await loadReconcileSignals(req(client));
    expect(calls.map((c) => (c.ops[1][1][1] as string[]).length)).toEqual([100, 100, 50]);
  });
});

describe("loadFailedSignals", () => {
  it("lists the week's failures and the held attempts from one composition", async () => {
    composeWith({ failed: [attempt(3, 3, "failed")], needs_reconciliation: [] });
    const { client } = tableClient({ billing_line_items: { data: [billRow(3, NOV, { start: "2026-11-01", end: "2026-11-30" })] } });
    const out = await loadFailedSignals(req(client));
    expect(listAttention.mock.calls).toEqual([[{ status: "failed", since: "2026-11-13T09:00:00.000Z" }], [{ status: "needs_reconciliation" }]]);
    expect(composePayments).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(out.map((s) => [s.severity, s.title, s.href])).toEqual([
      ["warn", "North site: 1 payment failed in November 2026", `/microgrids/${MG}/billing/${NOV}/payments?bill=${bill(3)}`],
    ]);
  });
});

describe("loadNotSubmittedSignals", () => {
  it("lists the last day's checkouts never submitted, reads the communities that reach three through the person's client, and disposes", async () => {
    composeWith({
      checkout_not_submitted: [
        notSubmitted(1, COMMUNITY, "2026-11-20T08:30:00Z"),
        notSubmitted(2, COMMUNITY),
        notSubmitted(3, COMMUNITY),
        notSubmitted(4, OTHER_COMMUNITY),
        notSubmitted(5, OTHER_COMMUNITY),
      ],
    });
    const { client, calls } = tableClient({ communities: { data: [{ id: COMMUNITY, name: "North village" }] } });
    const out = await loadNotSubmittedSignals(req(client));
    expect(composePayments).toHaveBeenCalledWith({ supabase: client, organizationId: ORG });
    expect(listAttention.mock.calls).toEqual([[{ status: "failed", since: "2026-11-19T09:00:00.000Z", failureCode: "checkout_not_submitted" }]]);
    expect(dispose).toHaveBeenCalledOnce();
    // Only the community with three or more is read.
    expect(calls).toEqual([
      {
        table: "communities",
        ops: [
          ["select", ["id, name"]],
          ["eq", ["org_id", ORG]],
          ["in", ["id", [COMMUNITY]]],
        ],
      },
    ]);
    expect(out).toEqual([
      {
        id: COMMUNITY,
        kind: "your-move",
        severity: "warn",
        title: "North village: 3 checkouts did not reach Pesapal in the last 24 hours",
        facts: [{ t: "text", text: "Check the payment account" }],
        entity: { kind: "community", id: COMMUNITY, label: "North village" },
        href: `/communities/${COMMUNITY}/payment`,
        at: "2026-11-20T08:30:00.000Z",
      },
    ]);
  });

  it("reads nothing more when no community reaches three", async () => {
    composeWith({ checkout_not_submitted: [notSubmitted(1, COMMUNITY), notSubmitted(2, COMMUNITY), notSubmitted(3, null)] });
    const { client, calls } = tableClient({});
    expect(await loadNotSubmittedSignals(req(client))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("throws when the listing is truncated, so the watcher is listed as unchecked rather than undercounting", async () => {
    composeWith({ checkout_not_submitted: [notSubmitted(1, COMMUNITY)] }, true);
    const { client } = tableClient({});
    await expect(loadNotSubmittedSignals(req(client))).rejects.toThrow("payments.not-submitted: more checkouts than one read returns");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("throws on a refused listing or a failed communities read, without their messages", async () => {
    composeWith({ checkout_not_submitted: { ok: false, status: 400 } });
    const { client } = tableClient({});
    await expect(loadNotSubmittedSignals(req(client))).rejects.toThrow("payments watcher: listAttention refused (400)");

    composeWith({ checkout_not_submitted: [1, 2, 3].map((n) => notSubmitted(n, COMMUNITY)) });
    const failing = tableClient({ communities: { data: null, error: { message: SECRET } } });
    const read = loadNotSubmittedSignals(req(failing.client));
    await expect(read).rejects.toThrow("payments.not-submitted: the communities could not be read");
    await expect(read).rejects.not.toThrow(SECRET);
  });
});

describe("the payments signal models", () => {
  const bills = new Map<string, AttentionBill>(
    [
      { n: 1, period: OCT, status: "unpaid" },
      { n: 2, period: OCT, status: "paid" },
      { n: 3, period: NOV, status: "refunded" },
      { n: 4, period: NOV, status: "failed" },
    ].map(({ n, period, status }) => [
      bill(n),
      { id: bill(n), paymentStatus: status as AttentionBill["paymentStatus"], periodId: period, startDate: "2026-10-01", endDate: "2026-10-31", microgridId: MG, microgridName: "North site" },
    ]),
  );

  it("leaves failures on paid, refunded or held bills, and on bills the person cannot see, out", () => {
    const failed = [attempt(1, 1, "failed"), attempt(2, 2, "failed"), attempt(3, 3, "failed"), attempt(4, 4, "failed"), attempt(5, 9, "failed")];
    expect(buildFailedSignals(fmt, failed, [], bills).map((s) => s.id)).toEqual([OCT, NOV]);
    expect(buildFailedSignals(fmt, failed, [attempt(6, 1, "needs_reconciliation")], bills).map((s) => s.href)).toEqual([
      `/microgrids/${MG}/billing/${NOV}/payments?bill=${bill(4)}`,
    ]);
  });

  it("lists periods by their newest attempt and stops at the host's cap", () => {
    const many = new Map<string, AttentionBill>();
    const held: AttentionAttempt[] = [];
    for (let i = 0; i < MAX_SIGNALS_PER_SOURCE + 2; i++) {
      many.set(`b${i}`, { id: `b${i}`, paymentStatus: "unpaid", periodId: `p${i}`, startDate: "2026-10-01", endDate: "2026-10-31", microgridId: MG, microgridName: "North site" });
      held.push({ ...attempt(i, 0, "needs_reconciliation", new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString()), lineItemId: `b${i}` });
    }
    const out = buildReconcileSignals(fmt, held, many);
    expect(out).toHaveLength(MAX_SIGNALS_PER_SOURCE);
    expect(out[0].id).toBe(`p${MAX_SIGNALS_PER_SOURCE + 1}`);
  });

  it("counts a period with any held attempt that reached the provider as critical, mixed or not", () => {
    const held = (n: number, billN: number, reachedProvider: boolean) => attempt(n, billN, "needs_reconciliation", undefined, { reachedProvider });
    const out = buildReconcileSignals(fmt, [held(1, 1, false), held(2, 1, true), held(3, 4, false)], bills);
    expect(out.map((s) => [s.id, s.severity])).toEqual([
      [OCT, "critical"],
      [NOV, "warn"],
    ]);
  });

  it(`reports a community from ${NOT_SUBMITTED_THRESHOLD} checkouts never submitted, leaving out unknown and unseen communities`, () => {
    const names = new Map([
      [COMMUNITY, "North village"],
      [OTHER_COMMUNITY, "South village"],
    ]);
    const two = [notSubmitted(1, OTHER_COMMUNITY), notSubmitted(2, OTHER_COMMUNITY)];
    const unseen = [1, 2, 3].map((n) => notSubmitted(10 + n, "e7f30000-0000-4000-8000-0000000000f9"));
    const unknown = [1, 2, 3].map((n) => notSubmitted(20 + n, null));
    const three = [1, 2, 3].map((n) => notSubmitted(30 + n, COMMUNITY));
    expect(buildNotSubmittedSignals(fmt, [...two, ...unseen, ...unknown, ...three], names).map((s) => s.id)).toEqual([COMMUNITY]);
    expect(buildNotSubmittedSignals(fmt, [...two, notSubmitted(3, OTHER_COMMUNITY, "2026-11-20T09:00:00Z"), ...three], names).map((s) => s.id)).toEqual([
      OTHER_COMMUNITY,
      COMMUNITY,
    ]);
  });

  it("returns signals a watcher may send, as the examples are", () => {
    const examples = [...RECONCILE_EXAMPLES, ...FAILED_EXAMPLES, ...NOT_SUBMITTED_EXAMPLES];
    for (const s of examples) expect(signalOutSchema.safeParse(s).success).toBe(true);
    expect(examples.map((s) => [s.severity, s.title])).toEqual([
      ["critical", "Kiwumu: 2 payments in October 2026 need reconciliation"],
      ["warn", "Kiwumu: 1 checkout in November 2026 needs reconciliation"],
      ["warn", "Kiwumu: 1 payment failed in November 2026"],
      ["warn", "Kiwumu village: 4 checkouts did not reach Pesapal in the last 24 hours"],
    ]);
    expect(JSON.stringify(examples)).not.toMatch(/trk|tracking/i);
  });
});
