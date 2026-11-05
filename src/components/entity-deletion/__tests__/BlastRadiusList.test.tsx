// @vitest-environment jsdom
//
// BlastRadiusList — the edge warning for meter readings taken during closed
// billing periods.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BlastRadiusList } from "../BlastRadiusList";

const AS_OF = "2026-11-03T12:00:00.000Z";

function edgeCounts(readingsInClosedPeriods: number) {
  return {
    kind: "edge" as const,
    devices: 2,
    household_devices: 1,
    billing_line_items_nulled: 3,
    readings_in_closed_periods: readingsInClosedPeriods,
  };
}

describe("BlastRadiusList", () => {
  it("warns that readings from closed billing periods go with the edge's devices", () => {
    render(<BlastRadiusList counts={edgeCounts(12)} asOf={AS_OF} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Readings from closed billing periods");
    expect(banner.textContent).toContain(
      "12 meter readings taken during closed billing periods will be deleted"
    );
    expect(banner.textContent).toContain(
      "The closed bills keep their recorded start and end readings and totals."
    );
  });

  it("uses the singular for one reading", () => {
    render(<BlastRadiusList counts={edgeCounts(1)} asOf={AS_OF} />);
    expect(screen.getByRole("status").textContent).toContain(
      "1 meter reading taken during closed billing periods"
    );
  });

  it("shows no warning when no reading falls in a closed period", () => {
    render(<BlastRadiusList counts={edgeCounts(0)} asOf={AS_OF} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/2 devices/)).toBeTruthy();
  });
});
