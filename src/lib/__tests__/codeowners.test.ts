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

  // The conformance kit every interface plugin runs is code-owned, on its own line.
  it("owns the conformance kit by its own pattern", () => {
    expect(patterns()).toContain("/src/lib/gui/conformance/");
    expect(tracked.some((f) => f.startsWith("src/lib/gui/conformance/"))).toBe(true);
  });

  const owned = (file: string) =>
    patterns().some((pattern) => {
      const rel = pattern.replace(/^\//, "");
      return pattern.endsWith("/") ? file.startsWith(rel) : file === rel;
    });

  // Decision 4 on #115: the GUI host's routes are code-owned.
  it("owns every file of the GUI host's routes", () => {
    const files = tracked.filter((f) => f.startsWith("src/app/api/gui/"));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !owned(f))).toEqual([]);
  });

  // Decision 4 on #115: the layout that checks the session and renders the
  // selected GUI's shell, and the list of GUIs it renders from.
  it.each(["src/app/(gui)/layout.tsx", "src/gui/installed.ts"])("owns %s", (file) => {
    expect(tracked).toContain(file);
    expect(owned(file)).toBe(true);
  });
});
