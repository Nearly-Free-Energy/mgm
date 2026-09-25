import { describe, expect, it } from "vitest";
import { computeAssignmentGaps } from "../assignment-gaps";

describe("computeAssignmentGaps", () => {
  it("returns no gaps for a single open link", () => {
    const { sorted, gaps } = computeAssignmentGaps([
      { effectiveFrom: "2026-01-01", effectiveTo: null },
    ]);
    expect(sorted).toHaveLength(1);
    expect(gaps).toEqual([]);
  });

  it("allows same-day boundaries without a gap", () => {
    const { gaps } = computeAssignmentGaps([
      { effectiveFrom: "2026-01-01", effectiveTo: "2026-03-01" },
      { effectiveFrom: "2026-03-01", effectiveTo: null },
    ]);
    expect(gaps).toEqual([]);
  });

  it("reports uncovered days between links", () => {
    const { gaps } = computeAssignmentGaps([
      { effectiveFrom: "2026-01-01", effectiveTo: "2026-03-01" },
      { effectiveFrom: "2026-04-01", effectiveTo: null },
    ]);
    expect(gaps).toEqual([{ from: "2026-03-01", to: "2026-04-01" }]);
  });

  it("flags missing boundary evidence on open-ended links followed by newer ones", () => {
    const { gaps } = computeAssignmentGaps([
      { effectiveFrom: "2026-01-01", effectiveTo: null },
      { effectiveFrom: "2026-04-01", effectiveTo: null },
    ]);
    expect(gaps).toEqual([{ from: "2026-01-01", to: "2026-04-01" }]);
  });

  it("sorts unordered input", () => {
    const { sorted } = computeAssignmentGaps([
      { effectiveFrom: "2026-04-01", effectiveTo: null },
      { effectiveFrom: "2026-01-01", effectiveTo: "2026-04-01" },
    ]);
    expect(sorted.map((l) => l.effectiveFrom)).toEqual([
      "2026-01-01",
      "2026-04-01",
    ]);
  });
});
