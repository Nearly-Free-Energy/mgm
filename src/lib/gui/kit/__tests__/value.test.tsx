import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Value as ValueOf } from "../../contract";
import { Value, ageText } from "../value";

vi.mock("next/navigation", () => ({ usePathname: () => null, useSearchParams: () => null, useRouter: () => ({}) }));

const show = (value: ValueOf, live?: Parameters<typeof Value>[0]["live"]) =>
  render(<Value value={value} live={live} />).container;

describe("Value", () => {
  it("prints the server's text, unit included, and the text of a type it does not know", () => {
    show({ t: "energy", v: 4.2, unit: "kWh", text: "4.2 kWh" });
    show({ t: "gauge", text: "71 of 100" } as unknown as ValueOf);
    expect(screen.getByText("4.2 kWh")).toBeTruthy();
    expect(screen.getByText("71 of 100")).toBeTruthy();
  });

  it("draws a status as a chip in its tone", () => {
    show({ t: "status", v: "late", tone: "warning", text: "Late" });
    expect(screen.getByText("Late").className).toContain("bg-warning-muted");
  });

  it("links a reference that carries a page", () => {
    show({ t: "ref", ref: { kind: "microgrid", id: "m", label: "Site", href: "/microgrids/m" }, text: "Site" });
    expect(screen.getByRole("link", { name: "Site" }).getAttribute("href")).toBe("/microgrids/m");
  });

  it("marks calculated and generated values", () => {
    show({ t: "percent", v: 40, text: "40%", derived: true, synthetic: true });
    expect(screen.getByTitle("Calculated").textContent).toContain("≈");
    expect(screen.getByText("Synthetic")).toBeTruthy();
  });

  it("shows a measured value's age, and stale once live says so", () => {
    const value: ValueOf = { t: "power", v: 1, unit: "kW", text: "1.0 kW", at: "2026-11-10T11:55:00Z" };
    show(value, { ageSeconds: () => 300, stale: () => true });
    expect(screen.getByText(/5 min ago/).textContent).toBe("5 min ago, stale");
    expect(show({ ...value, at: undefined }, { ageSeconds: () => null, stale: () => false }).textContent).toBe("1.0 kW");
  });
});

describe("ageText", () => {
  it("rounds down to seconds, minutes, hours and days", () => {
    expect([59, 60, 3599, 3600, 86400].map(ageText)).toEqual(["59 s ago", "1 min ago", "59 min ago", "1 h ago", "1 d ago"]);
  });
});
