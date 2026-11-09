import { describe, expect, it } from "vitest";
import { CARET_RANGE_RE, satisfiesContract } from "../contract-range";
import { guiMetaSchema } from "../../server/model-schema";

describe("satisfiesContract", () => {
  it.each([
    ["0.1.0", "^0.1", true],
    ["0.1.9", "^0.1", true],
    ["0.2.0", "^0.1", false],
    ["0.0.9", "^0.1", false],
    ["0.1.2", "^0.1.3", false],
    ["0.1.3", "^0.1.3", true],
    ["0.1.7", "^0.1.3", true],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["0.0.9", "^0.0", true],
    ["0.1.0", "^0.0", false],
    ["1.2.0", "^1.2", true],
    ["1.9.0", "^1.2", true],
    ["2.0.0", "^1.2", false],
    ["1.1.9", "^1.2", false],
    ["1.2.4", "^1.2.5", false],
  ])("%s in %s is %s", (version, range, expected) => {
    expect(satisfiesContract(version, range)).toBe(expected);
  });

  it.each(["0.1", ">=0.1", "^0.1.x", "^v0.1", "^0.1 || ^0.2", "", "^1", "~0.1", "^01.2", "^0.1.0-beta"])(
    "refuses the range %j",
    (range) => {
      expect(() => satisfiesContract("0.1.0", range)).toThrow(/Unsupported contract range/);
    },
  );

  it.each(["0.1", "v0.1.0", "0.1.0-beta", ""])("refuses the version %j", (version) => {
    expect(() => satisfiesContract(version, "^0.1")).toThrow(/Not a contract version/);
  });

  it("accepts in GuiMeta exactly the ranges it can evaluate", () => {
    const meta = { name: "probe", title: "Probe", version: "1.0.0", styles: "./a.css", dependencies: [] };
    for (const range of ["^0.1", "^0.1.3", "^1.2", "0.1", "^0.1.x", ""]) {
      expect(guiMetaSchema.safeParse({ ...meta, contract: range }).success).toBe(CARET_RANGE_RE.test(range));
    }
  });
});
