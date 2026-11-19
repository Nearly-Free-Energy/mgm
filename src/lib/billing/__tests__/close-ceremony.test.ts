import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createFmt } from "@/lib/gui/fmt";
import { ceremonySchema } from "@/lib/gui/host/server/model-schema";
import { closeCeremony } from "../close-ceremony";
import { CLOSE_ACKNOWLEDGEMENTS, parseCloseReview, type CloseReview } from "../close";

const fmt = createFmt({ locale: "en-UG" });

function review(change: Record<string, unknown> = {}): CloseReview {
  const parsed = parseCloseReview({
    periodId: "770e8400-e29b-41d4-a716-446655440000",
    microgridId: "660e8400-e29b-41d4-a716-446655440000",
    status: "draft",
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    currency: "UGX",
    billCount: 12,
    totalAmount: 4216800,
    usageKwh: 1840.5,
    unbilled: [],
    unmetered: [],
    fractionalTotals: [],
    acknowledgements: ["totals_reviewed"],
    digest: "v1:abc",
    ...change,
  });
  if (!parsed) throw new Error("review fixture does not parse");
  return parsed;
}

const houses = (n: number) => Array.from({ length: n }, (_, i) => ({ tenantId: `t-${i + 1}`, tenantName: `House ${i + 1}` }));

describe("closeCeremony", () => {
  it("carries the review's digest, name and acknowledgements, in the host's ceremony shape", () => {
    const ceremony = closeCeremony(review(), fmt);
    expect(ceremonySchema.safeParse(ceremony).success).toBe(true);
    expect(ceremony).toMatchObject({
      type: "ceremony",
      digest: "v1:abc",
      typed: "October 2026",
      acknowledgements: [{ id: "totals_reviewed", label: CLOSE_ACKNOWLEDGEMENTS.totals_reviewed }],
      warnings: [],
    });
    expect(ceremony.statement).toMatch(/^Close October 2026\./);
  });

  it("shows the period, bills, energy and total as formatted facts", () => {
    const { facts } = closeCeremony(review(), fmt);
    expect(facts.map((f) => f.label)).toEqual(["Period", "Bills", "Energy", "Total"]);
    expect(facts[0].value).toEqual({ t: "text", text: "October 2026" });
    expect(facts[1].value).toMatchObject({ t: "number", v: 12, text: "12" });
    expect(facts[2].value).toMatchObject({ t: "energy", v: 1840.5, unit: "kWh" });
    expect(facts[3].value).toMatchObject({ t: "money", v: 4216800, currency: "UGX" });
    expect(facts[3].value.text).toContain("4,216,800");
  });

  it("warns about tenants with no bill, bills with no usage and fractional totals, naming at most five", () => {
    const ceremony = closeCeremony(
      review({
        unbilled: houses(7),
        unmetered: houses(1),
        fractionalTotals: houses(2),
        acknowledgements: ["totals_reviewed", "tenants_without_bills", "bills_without_usage"],
      }),
      fmt
    );
    expect(ceremonySchema.safeParse(ceremony).success).toBe(true);
    expect(ceremony.warnings).toEqual([
      "2 bills have a total that is not a whole number: House 1, House 2. Regenerate them before closing.",
      "7 tenants have no bill in this period: House 1, House 2, House 3, House 4, House 5 and 2 more.",
      "1 bill has no usage recorded: House 1.",
    ]);
    expect(ceremony.acknowledgements.map((a) => a.id)).toEqual([
      "totals_reviewed",
      "tenants_without_bills",
      "bills_without_usage",
    ]);
  });
});
