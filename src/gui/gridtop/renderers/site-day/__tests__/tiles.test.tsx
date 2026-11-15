/**
 * The Operations day's tiles in Gridtop: the legacy page's tile cases
 * (src/components/operations/__tests__/daily-operations.test.tsx), ported.
 * The copy itself is the server's now (site-day-model.test.tsx pins it);
 * these pin where each piece lands and how it is marked.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tiles, type Tile } from "../tiles";
import { TILES, dayModel, empty, kwh, num, pct } from "./site-day-fixture";

const tilesOf = (o: Parameters<typeof dayModel>[0] = {}) => dayModel(o).body.tiles as Tile[];

function draw(tiles: Tile[] = TILES) {
  return render(<Tiles tiles={tiles} />).container;
}

/** The tile headed `label`. */
function tile(root: HTMLElement, label: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>("[data-tile]")].find((s) => s.querySelector("h3")?.textContent === label);
  if (!found) throw new Error(`No tile labelled ${label}`);
  return found;
}
/** Its figure: the paragraph after the heading row. */
const value = (root: HTMLElement, label: string) => tile(root, label).querySelector("p")?.textContent ?? "";
const hint = (root: HTMLElement, label: string) => tile(root, label).querySelectorAll("p")[1]?.textContent ?? null;

describe("the site-day tiles", () => {
  it("shows the six tiles in the page's order, and leaves the evening supply to the evening strip", () => {
    const root = draw();
    expect([...root.querySelectorAll("[data-tile]")].map((s) => s.getAttribute("data-tile"))).toEqual([
      "solar", "houses-evening", "cuts", "lowest-soc", "soc-17", "lights-on",
    ]);
    expect(root.textContent).not.toContain("Who served the houses");
  });

  // Legacy: "shows solar, and what the houses used in the evening with the battery's share, in kWh".
  it("shows solar, and what the houses used in the evening with the battery's share", () => {
    const root = draw();
    expect(value(root, "Solar")).toBe("12.3 kWh");
    expect(hint(root, "Solar")).toBe("Solar meter");
    expect(value(root, "Houses used 18:00–24:00")).toBe("3.2 kWh");
    expect(hint(root, "Houses used 18:00–24:00")).toBe("Battery supplied 4.6 kWh");
  });

  // Legacy: "labels the evening tile from the evening start, with an en dash".
  it("labels the evening tile as the server wrote it", () => {
    expect(() => tile(draw(), "Houses used 18:00–24:00")).not.toThrow();
  });

  // Legacy: meters without data; household meters needed; before 18:00; no battery registered;
  // no battery readings; a battery that only charged.
  it.each([
    "Battery supplied 4.6 kWh · 2 meters without data",
    "Needs household meters · Battery supplied 4.6 kWh",
    "From 18:00",
    "No battery registered",
    "No battery readings",
    "Battery supplied 0.0 kWh",
  ])("prints the houses' hint %j as given", (text) => {
    const root = draw(tilesOf({ tiles: { "houses-evening": { hint: text } } }));
    expect(hint(root, "Houses used 18:00–24:00")).toBe(text);
  });

  // Legacy: "shows an em dash when no house meter has the evening's readings".
  it("shows an em dash when the houses' figure is empty", () => {
    const root = draw(tilesOf({ tiles: { "houses-evening": { value: empty } } }));
    expect(value(root, "Houses used 18:00–24:00")).toBe("—");
  });

  // Legacy: em dash for no solar readings, and for a balance with nothing to estimate from.
  it.each(["No solar meter readings", `No complete inverter, grid and battery readings`])(
    "shows an em dash for solar with the hint %j",
    (text) => {
      const root = draw(tilesOf({ tiles: { solar: { value: empty, hint: text } } }));
      expect(value(root, "Solar")).toBe("—");
      expect(hint(root, "Solar")).toBe(text);
    },
  );

  // Legacy: "marks solar as estimated when it is the balance at the inverter".
  it("marks an estimated figure with ≈ and an accessible 'estimated'", () => {
    const root = draw(tilesOf({ tiles: { solar: { value: kwh(10.5, "10.5 kWh", true), hint: `≈ inverter output − grid − battery` } } }));
    const figure = tile(root, "Solar").querySelector("p")!;
    expect(figure.textContent).toBe("≈ estimated 10.5 kWh");
    expect(figure.querySelector('[aria-hidden="true"]')?.textContent).toBe("≈ ");
    expect(figure.querySelector(".gt\\:sr-only")?.textContent).toBe("estimated ");
    expect(value(draw(), "Solar")).not.toContain("≈");
  });

  // Legacy: "shows power cuts as 'count / duration'" and "shows zero cuts as '0 / 0m'".
  it("shows power cuts as 'count / duration', zero cuts included", () => {
    expect(value(draw(), "Power cuts")).toBe("2 / 4h 10m");
    const none = draw(tilesOf({ tiles: { cuts: { value: num(0, "0"), status: null }, "cut-time": { value: num(0, "0m", "min") } } }));
    expect(value(none, "Power cuts")).toBe("0 / 0m");
    expect(hint(none, "Power cuts")).toBe(`Cuts / time without grid power`);
  });

  // Legacy: "shows the lowest battery level, its time, and whether it was in a cut", and without one.
  it("shows the lowest battery level and its hint", () => {
    const root = draw();
    expect(value(root, "Lowest battery")).toBe("12%");
    expect(hint(root, "Lowest battery")).toBe("At 05:30, in a cut");
    expect(hint(draw(tilesOf({ tiles: { "lowest-soc": { hint: "At 05:30" } } })), "Lowest battery")).toBe("At 05:30");
  });

  // Legacy: "warns at a lowest level at or below the battery's floor, not above it".
  it("shows a status as a chip of its tone, and none without a status", () => {
    const floor = tile(draw(), "Lowest battery").querySelector("h3 + span")!;
    expect(floor.textContent).toBe("At the floor");
    expect(floor.className).toContain("gt:bg-warning-muted");
    const above = draw(tilesOf({ tiles: { "lowest-soc": { value: pct(40, "40%"), status: null } } }));
    expect(tile(above, "Lowest battery").querySelector("h3 + span")).toBeNull();
    expect(tile(draw(), "Power cuts").querySelector("h3 + span")?.className).toContain("gt:text-warning-fg");
    expect(tile(draw(), "Lights on").querySelector("h3 + span")?.className).toContain("gt:bg-destructive-muted");
  });

  // Legacy: "shows the battery level at 17:00".
  it("shows the battery level at 17:00", () => {
    const root = draw();
    expect(value(root, "Battery at 17:00")).toBe("64%");
    expect(hint(root, "Battery at 17:00")).toBe("Before the evening window");
  });

  // Legacy: lights on with one decimal and the dark time; inferred dark time and no data; no dark time.
  it.each(["Dark 1h 0m", "Dark 1h 0m (20m inferred from a low battery) · No data 30m", "No dark time · No data 45m", "No dark time"])(
    "shows lights on with the hint %j",
    (text) => {
      const root = draw(tilesOf({ tiles: { "lights-on": { hint: text } } }));
      expect(value(root, "Lights on")).toBe("95.8%");
      expect(hint(root, "Lights on")).toBe(text);
    },
  );

  // Legacy: "shows an em dash and what is needed when values are null".
  it("shows an em dash and what is needed when values are empty", () => {
    const root = draw(
      tilesOf({
        tiles: {
          solar: { value: empty, hint: `Needs a solar meter, or an inverter output meter with the battery and grid meter` },
          "houses-evening": { value: empty, hint: "Needs household meters · No battery registered" },
          cuts: { value: empty, hint: `Needs a grid meter`, status: null },
          "cut-time": { value: empty },
          "lowest-soc": { value: empty, hint: "Needs a battery", status: null },
          "soc-17": { value: empty, hint: "No reading at 17:00" },
          "lights-on": { value: empty, hint: "No dark time", status: null },
        },
      }),
    );
    for (const label of ["Solar", "Houses used 18:00–24:00", "Power cuts", "Lowest battery", "Battery at 17:00", "Lights on"]) {
      expect(value(root, label), label).toBe("—");
    }
    expect(hint(root, "Power cuts")).toBe(`Needs a grid meter`);
    expect(hint(root, "Lowest battery")).toBe("Needs a battery");
    expect(hint(root, "Battery at 17:00")).toBe("No reading at 17:00");
  });

  it("prints figures at the KPI size with tabular digits and labels at the caption size, with no decorative colour", () => {
    const root = draw();
    for (const section of root.querySelectorAll("[data-tile]")) {
      expect(section.querySelector("h3")?.className).toContain("gt:text-caption");
      const figure = section.querySelector("p")!;
      expect(figure.className).toContain("gt:text-kpi");
      expect(figure.className).toContain("gt:tabular-nums");
      expect(figure.className).toContain("gt:text-foreground");
      expect(figure.className).not.toMatch(/warning|success|destructive/);
    }
    expect(tile(root, "Solar").querySelector("h3 + span")).toBeNull();
  });

  it("marks each synthetic figure, chip and the battery's share in the houses' hint", () => {
    const root = draw(tilesOf({ synthetic: true }));
    expect(tile(root, "Power cuts").querySelector("p")?.textContent).toBe("2* (synthetic) / 4h 10m* (synthetic)");
    expect(tile(root, "Lights on").querySelector("h3 + span")?.textContent).toBe("Houses dark* (synthetic)");
    expect(hint(root, "Houses used 18:00–24:00")).toBe("Battery supplied 4.6 kWh* (synthetic)");
    for (const mark of root.querySelectorAll('[title="Synthetic"]')) expect(mark.querySelector('[aria-hidden="true"]')?.textContent).toBe("*");
    expect(draw().querySelector('[title="Synthetic"]')).toBeNull();
  });

  // Legacy: "uses token colour classes only, no hard-coded Tailwind palette".
  it("uses token colour classes only", () => {
    const palette = /\b(?:bg|text|fill|stroke|border)-(?:red|blue|green|gray|slate|zinc|amber|orange|yellow|emerald)-\d/;
    for (const tiles of [TILES, tilesOf({ synthetic: true })]) expect(draw(tiles).innerHTML).not.toMatch(palette);
  });
});
