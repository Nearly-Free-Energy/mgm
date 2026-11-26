/**
 * Keeps investigation-cases.pins.ts in step with docs/investigation-cases.md
 * §2, the cases' answer key for A3 and the manual baseline's script. The
 * pins restate the document, and investigation-cases.test.ts checks the
 * generator against the pins, so without this a pin or figure changed on one
 * side only would leave both suites green.
 *
 * For every case row of §2 it compares the case id, and for an existing case
 * its microgrid and date, the scenario the row names (`exists: \`clear\`` or
 * "on a `floor-at-dawn` day"), and its `tenantMetersEveningKwh`, with CASES.
 * A row whose "Microgrid, date" cell says pending is held only to being
 * pending in CASES too: its microgrid and date are A2-4's to write into the
 * document. When A2-4 does, the existing-row branch covers them with no
 * change here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CASES } from "./investigation-cases.pins";

const DOC = path.resolve(__dirname, "../../../../docs/investigation-cases.md");

type DocRow = {
  id: string;
  /** Whether the "Microgrid, date" cell says "pending" (C23's says "pending (half exists)"). */
  pending: boolean;
  /** The "Microgrid, date" cell's microgrid and date, or null when it holds none. */
  place: { microgrid: string; date: string } | null;
  mechanism: string;
  evidence: string;
};

/** Every row of §2's case tables (`| Cnn Title | … |`), in order. */
function docRows(): DocRow[] {
  const rows: DocRow[] = [];
  for (const line of readFileSync(DOC, "utf8").split("\n")) {
    const cells = /^\|\s*(C\d\d)\b/.test(line) ? line.split("|").slice(1, -1).map((c) => c.trim()) : null;
    if (!cells || cells.length < 4) continue;
    const id = /^(C\d\d)\b/.exec(cells[0])![1];
    const place = /^([0-9a-f]{2}), (\d{4}-\d\d-\d\d)$/.exec(cells[1]);
    rows.push({
      id,
      pending: cells[1].startsWith("pending"),
      place: place ? { microgrid: place[1], date: place[2] } : null,
      mechanism: cells[2],
      evidence: cells[3],
    });
  }
  return rows;
}

/** The scenario a mechanism cell names, if it names one. */
function namedScenario(mechanism: string): string | null {
  return (/^exists: `([a-z-]+)`/.exec(mechanism) ?? /on a `([a-z-]+)` day/.exec(mechanism))?.[1] ?? null;
}

describe("investigation-cases.pins.ts restates docs/investigation-cases.md §2", () => {
  const rows = docRows();

  it("finds all 24 case rows, once each", () => {
    expect(rows.map((r) => r.id).sort()).toEqual(CASES.map((c) => c.id).sort());
  });

  for (const row of rows) {
    const pin = CASES.find((c) => c.id === row.id);

    it(`${row.id}: the same mechanism, microgrid, date, scenario and evening kWh`, () => {
      expect(pin, `${row.id} is in the document but not in CASES`).toBeDefined();
      if (!pin) return;
      if (row.pending) {
        expect(pin.mechanism).toBe("pending");
        return;
      }
      expect(pin.mechanism).toBe("exists");
      expect(row.place, `${row.id}'s "Microgrid, date" cell`).not.toBeNull();
      expect({ microgrid: pin.microgrid, date: pin.date }).toEqual(row.place);

      const scenario = namedScenario(row.mechanism);
      if (scenario !== null) expect(pin.scenario).toBe(scenario);

      const kwh = /`tenantMetersEveningKwh` (\d+\.\d{3})/.exec(row.evidence)?.[1];
      if (kwh !== undefined) {
        expect(pin.read?.ok, `${row.id} states a kWh, so its read succeeds`).toBe(true);
        if (pin.read?.ok) expect(pin.read.figures.housesEveningKwh).toBeCloseTo(Number(kwh), 3);
      }
    });
  }
});
