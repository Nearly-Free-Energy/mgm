/**
 * The suite describeGuiConformance registers, with the test API and the
 * installed metadata passed in, so the kit's own tests can collect the cases
 * and check the reference GUI against metadata that is not installed. Only
 * index.ts and the kit's tests import this module; a GUI's tests may import
 * only the index (gui-boundary.test.ts, rule 8).
 */
import { expect } from "vitest";
import type { GuiPlugin } from "../contract";
import { CHECKS, type CheckId, type CheckOptions, type Finding } from "./checks";

export interface TestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

const describeFinding = (f: Finding) => `${f.fixture}: ${f.message}`;

/** One `describe` per GUI and one `it` per check, failing with the check's findings. */
export function registerConformance(gui: GuiPlugin, options: CheckOptions, api: TestApi): void {
  api.describe(`${gui.name} conforms to the GUI contract`, () => {
    for (const id of Object.keys(CHECKS) as CheckId[]) {
      api.it(id, async () => {
        const findings = await CHECKS[id](gui, options);
        const lines = findings.map(describeFinding);
        expect(lines, lines.join("\n")).toEqual([]);
      });
    }
  });
}
