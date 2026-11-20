import "server-only";

/**
 * Examples of the payments watchers' signals, built by their own model, so
 * they are what the watchers return: two attempts held for reconciliation on
 * two bills of one period, and a failure on one bill of another. All data is
 * synthetic.
 */
import { createFmt } from "@/lib/gui/fmt";
import type { SignalOut } from "@/lib/gui/surface";
import type { AttentionAttempt } from "../repository";
import { buildFailedSignals, buildReconcileSignals, type AttentionBill } from "./attention-signals-model";

const fmt = createFmt({ locale: "en-GB" });
const MICROGRID = "00000000-0000-4000-8000-0000000000b1";
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
  [bill(1, OCTOBER, "2026-10-01", "2026-10-31"), bill(2, OCTOBER, "2026-10-01", "2026-10-31"), bill(3, NOVEMBER, "2026-11-01", "2026-11-30")].map((b) => [b.id, b]),
);
const attempt = (n: number, billN: number, status: AttentionAttempt["status"], updatedAt: string): AttentionAttempt => ({
  id: `00000000-0000-4000-8000-0000000000e${n}`,
  lineItemId: `00000000-0000-4000-8000-0000000000d${billN}`,
  status,
  failureCode: status === "failed" ? "provider_failed" : "balance_mismatch",
  updatedAt,
});

export const RECONCILE_EXAMPLES: readonly SignalOut[] = buildReconcileSignals(
  fmt,
  [attempt(1, 1, "needs_reconciliation", "2026-11-18T10:05:00Z"), attempt(2, 2, "needs_reconciliation", "2026-11-17T14:30:00Z")],
  BILLS,
);

export const FAILED_EXAMPLES: readonly SignalOut[] = buildFailedSignals(fmt, [attempt(3, 3, "failed", "2026-11-19T07:45:00Z")], [], BILLS);
