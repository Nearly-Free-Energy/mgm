import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A CODEOWNERS pattern that matches no tracked file protects nothing and GitHub
// does not warn about it (for example after a file is renamed). If this fails,
// update .github/CODEOWNERS in the same change as the move.
const root = path.resolve(__dirname, "../../..");

function patterns(): string[] {
  return readFileSync(path.join(root, ".github/CODEOWNERS"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/)[0]);
}

describe("CODEOWNERS", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  it("lists at least one pattern", () => {
    expect(patterns().length).toBeGreaterThan(0);
  });

  it.each(patterns())("pattern %s matches a tracked file", (pattern) => {
    const rel = pattern.replace(/^\//, "");
    const matches = pattern.endsWith("/")
      ? tracked.some((f) => f.startsWith(rel))
      : tracked.includes(rel);
    expect(matches).toBe(true);
  });
});
