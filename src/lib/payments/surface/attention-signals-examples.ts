import "server-only";

/**
 * Examples of the payments watchers' signals, built by their own model, so
 * they are what the watchers return: two attempts held for reconciliation on
 * two bills of one period, one of which reached the provider (critical);
 * one held on a bill of another period that never reached it (a warning);
 * a failure on one bill of that other period; and four checkouts in a day
 * that never reached the provider in one community. All data is synthetic.
 */
import { createFmt } from "@/lib/gui/fmt";
import type { SignalOut } from "@/lib/gui/surface";
import type { AttentionAttempt } from "../repository";
import { buildFailedSignals, buildNotSubmittedSignals, buildReconcileSignals, type AttentionBill } from "./attention-signals-model";

const fmt = createFmt({ locale: "en-GB" });
const MICROGRID = "00000000-0000-4000-8000-0000000000b1";
const COMMUNITY = "00000000-0000-4000-8000-0000000000a1";
const OCTOBER = "00000000-0000-4000-8000-0000000000c1";
const NOVEMBER = "00000000-0000-4000-8000-0000000000c2";
const bill = (n: number, periodId: string, startDate: string, endDate: string): AttentionBill => ({
  id: `00000000-0000-4000-8000-0000000000d${n}`,
  paymentStatus: "unpaid",
  periodId,
  startDate,
  endDate,
  microgridId: MICROGRID,
  microgridName: "Kiwumu",
});
const BILLS = new Map(
  [
    bill(1, OCTOBER, "2026-10-01", "2026-10-31"),
    bill(2, OCTOBER, "2026-10-01", "2026-10-31"),
    bill(3, NOVEMBER, "2026-11-01", "2026-11-30"),
    bill(4, NOVEMBER, "2026-11-01", "2026-11-30"),
  ].map((b) => [b.id, b]),
);
const attempt = (
  n: number,
  billN: number,
  status: AttentionAttempt["status"],
  updatedAt: string,
  o: Partial<AttentionAttempt> = {},
): AttentionAttempt => ({
  id: `00000000-0000-4000-8000-0000000000e${n}`,
  lineItemId: `00000000-0000-4000-8000-0000000000d${billN}`,
  status,
  failureCode: status === "failed" ? "provider_failed" : "balance_mismatch",
  updatedAt,
  communityId: COMMUNITY,
  reachedProvider: true,
  ...o,
});

export const RECONCILE_EXAMPLES: readonly SignalOut[] = buildReconcileSignals(
  fmt,
  [
    attempt(1, 1, "needs_reconciliation", "2026-11-18T10:05:00Z"),
    attempt(2, 2, "needs_reconciliation", "2026-11-17T14:30:00Z", { reachedProvider: false }),
    attempt(4, 4, "needs_reconciliation", "2026-11-16T09:00:00Z", { failureCode: "bill_revised", reachedProvider: false }),
  ],
  BILLS,
);

export const FAILED_EXAMPLES: readonly SignalOut[] = buildFailedSignals(fmt, [attempt(3, 3, "failed", "2026-11-19T07:45:00Z")], [], BILLS);

export const NOT_SUBMITTED_EXAMPLES: readonly SignalOut[] = buildNotSubmittedSignals(
  fmt,
  [5, 6, 7, 8].map((n) =>
    attempt(n, 3, "failed", `2026-11-19T0${n}:00:00Z`, { failureCode: "checkout_not_submitted", reachedProvider: false }),
  ),
  new Map([[COMMUNITY, "Kiwumu village"]]),
);
