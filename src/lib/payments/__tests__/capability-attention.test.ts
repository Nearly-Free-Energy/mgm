/**
 * listAttention: the organization's attempts needing reconciliation, or
 * failed since an instant without the failures the capability records for
 * its own bookkeeping; its input checked, capped with `truncated`, and
 * answered while the plugins are off.
 */
import { describe, expect, it, vi } from "vitest";
import { PaymentsCapability } from "../capability";
import { MAX_ATTENTION_ATTEMPTS, type AttentionAttempt, type PaymentsRepository } from "../repository";
import { ATTEMPT, LINE_ITEM, ORG, baseRepo, providers, scope } from "./fixtures";

const row = (i: number, over: Partial<AttentionAttempt> = {}): AttentionAttempt => ({
  id: `${ATTEMPT}-${i}`,
  lineItemId: LINE_ITEM,
  status: "needs_reconciliation",
  failureCode: "balance_mismatch",
  updatedAt: "2026-11-19T08:00:00.000Z",
  ...over,
});

function capability(over: Partial<PaymentsRepository> = {}, active = true) {
  const listAttentionAttempts = vi.fn<PaymentsRepository["listAttentionAttempts"]>(async () => [row(1)]);
  const repo = baseRepo({ listAttentionAttempts, ...over });
  return { cap: new PaymentsCapability(repo, scope(), providers(), () => active, (p) => p), listAttentionAttempts };
}

describe("PaymentsCapability.listAttention", () => {
  it("lists the organization's attempts needing reconciliation", async () => {
    const { cap, listAttentionAttempts } = capability();
    expect(await cap.listAttention({ status: "needs_reconciliation" })).toEqual({ ok: true, data: { attempts: [row(1)], truncated: false } });
    expect(listAttentionAttempts).toHaveBeenCalledWith({ orgId: ORG, status: "needs_reconciliation", limit: MAX_ATTENTION_ATTEMPTS + 1 });
  });

  it("lists failures since an instant, leaving out the capability's own bookkeeping codes", async () => {
    const { cap, listAttentionAttempts } = capability();
    expect((await cap.listAttention({ status: "failed", since: "2026-11-13T12:00:00+03:00" })).ok).toBe(true);
    expect(listAttentionAttempts).toHaveBeenCalledWith({
      orgId: ORG,
      status: "failed",
      since: "2026-11-13T09:00:00.000Z",
      exceptFailureCodes: ["checkout_superseded", "checkout_not_submitted"],
      limit: MAX_ATTENTION_ATTEMPTS + 1,
    });
  });

  it(`answers at most ${MAX_ATTENTION_ATTEMPTS}, saying when there were more`, async () => {
    const many = Array.from({ length: MAX_ATTENTION_ATTEMPTS + 1 }, (_, i) => row(i));
    const { cap } = capability({ listAttentionAttempts: async () => many });
    const out = await cap.listAttention({ status: "needs_reconciliation" });
    expect(out.ok && [out.data.attempts.length, out.data.truncated]).toEqual([MAX_ATTENTION_ATTEMPTS, true]);
  });

  it.each([
    ["nothing", undefined],
    ["a string", "failed"],
    ["another status", { status: "verified" }],
    ["failed without since", { status: "failed" }],
    ["failed since something that is not a time", { status: "failed", since: "last week" }],
    ["reconciliation with since", { status: "needs_reconciliation", since: "2026-11-13T09:00:00Z" }],
    ["an extra field", { status: "needs_reconciliation", org: "another" }],
  ])("refuses %s with a 400, reading nothing", async (_label, input) => {
    const { cap, listAttentionAttempts } = capability();
    expect(await cap.listAttention(input)).toMatchObject({ ok: false, status: 400, code: "payments_invalid_attention_query" });
    expect(listAttentionAttempts).not.toHaveBeenCalled();
  });

  it("answers while Payments is off, reading no plugin state", async () => {
    const isPaymentsEnabled = vi.fn(async () => false);
    const { cap } = capability({ isPaymentsEnabled });
    expect((await cap.listAttention({ status: "needs_reconciliation" })).ok).toBe(true);
    expect(isPaymentsEnabled).not.toHaveBeenCalled();
  });

  it("refuses once its composition is disposed", async () => {
    const { cap, listAttentionAttempts } = capability({}, false);
    expect(await cap.listAttention({ status: "needs_reconciliation" })).toMatchObject({ ok: false, code: "payments_composition_disposed" });
    expect(listAttentionAttempts).not.toHaveBeenCalled();
  });

  it("lets a failed read reject, as listHistory does", async () => {
    const { cap } = capability({ listAttentionAttempts: async () => Promise.reject(new Error("Could not load payment attempts")) });
    await expect(cap.listAttention({ status: "needs_reconciliation" })).rejects.toThrow("Could not load payment attempts");
  });
});
