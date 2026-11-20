/**
 * The `payments.bill-attempts` examples (../bill-attempts-examples.ts) are
 * histories PaymentsCapability can produce, so no GUI is tested against a
 * row that never exists. A new checkout is reserved only on a bill that is
 * neither paid nor refunded and has no pending, confirmation-pending,
 * verified, resolved or held attempt (createCheckout in ../capability.ts and
 * fn_payment_reserve_checkout in 20261010202643_payments_integrity.sql). So
 * every attempt but a bill's latest has failed, and a paid bill's latest
 * attempt is the one that paid it. If those refusals change, revisit this.
 */
import { describe, expect, it } from "vitest";
import { BILL_ATTEMPTS_EXAMPLE_HISTORIES, BILL_ATTEMPTS_LOADED_EXAMPLES } from "../bill-attempts-examples";

describe("the bill attempts examples", () => {
  it.each(BILL_ATTEMPTS_EXAMPLE_HISTORIES.map((e) => [e.bill.tenantName, e] as const))(
    "%s: every attempt but the latest has failed",
    (_name, { history }) => {
      const byStart = [...history.attempts].sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const earlier of byStart.slice(0, -1)) expect(earlier.status, earlier.id).toBe("failed");
    },
  );

  it.each(BILL_ATTEMPTS_EXAMPLE_HISTORIES.map((e) => [e.bill.tenantName, e] as const))(
    "%s: a paid bill's latest attempt is the payment, and an unpaid bill has none",
    (_name, { bill, history }) => {
      const latest = [...history.attempts].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
      if (bill.payment_status === "paid") expect(["verified", "resolved"]).toContain(latest?.status);
      else expect(history.attempts.every((a) => !["verified", "resolved", "reversed"].includes(a.status))).toBe(true);
    },
  );

  it("draws each history's bill, and an unknown outcome only on an unpaid bill", () => {
    const unknown = BILL_ATTEMPTS_EXAMPLE_HISTORIES.filter((e) =>
      e.history.attempts.some((a) => !a.hasTracking && ["pending", "confirmation_pending", "needs_reconciliation"].includes(a.status)),
    );
    expect(unknown.length).toBeGreaterThan(0);
    for (const e of unknown) expect(e.bill.payment_status).not.toBe("paid");
    const titles = BILL_ATTEMPTS_LOADED_EXAMPLES.map((m) => m.title);
    for (const e of BILL_ATTEMPTS_EXAMPLE_HISTORIES) expect(titles.some((t) => t.includes(e.bill.tenantName)), e.bill.tenantName).toBe(true);
  });
});
