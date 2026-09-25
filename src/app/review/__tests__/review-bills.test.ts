import { describe, expect, it } from "vitest";
import { csvCell } from "../review-bills";

describe("review CSV cells", () => {
  it("keeps negative numeric values numeric while escaping formula-like text", () => {
    expect(csvCell(-1250)).toBe("\"-1250\"");
    expect(csvCell("-cmd|' /C calc'!A0")).toBe("\"'-cmd|' /C calc'!A0\"");
    expect(csvCell("=1+1")).toBe("\"'=1+1\"");
  });
});
