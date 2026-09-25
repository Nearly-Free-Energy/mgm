import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("billing provider boundary", () => {
  it("keeps vendor and Cordis imports out of the billing engine", async () => {
    const source = await readFile(
      new URL("../generate.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/@\/lib\/openems|from\s+["']cordis["']/);
    expect(source).toContain("meteringProvider");
  });
});
