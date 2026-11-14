/**
 * Signed-in pages live in the `(gui)` route group, whose layout redirects a
 * visitor to /login, /setup or /no-access. A page left in another group, or
 * added beside the groups, renders without that layout or its redirects.
 * The redirects are navigation, not an access check: what a page may read is
 * settled by RLS and by the page's own checks. This guard keeps the set of
 * route groups and the pages outside `(gui)` to the lists below, and keeps
 * the group's former name out of the code and docs. If the `(gui)` layout
 * stops making those redirects, revisit.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const APP = path.join(REPO_ROOT, "src", "app");
const SELF = "src/lib/__tests__/route-groups.test.ts";

/** Route groups directly under src/app. */
const ROUTE_GROUPS = ["(gui)"];

/** The group's name before it was renamed to `(gui)`. */
const FORMER_GROUP = "(dashboard)";

/**
 * Pages outside `(gui)`, relative to src/app. Each is reachable without a
 * role on purpose (sign-in, first run, an old bookmark's redirect), or is the
 * development-only component gallery. Add a page here only when it must
 * render without the `(gui)` layout's redirects.
 */
const PAGES_OUTSIDE_GUI = [
  "_dev/components/page.tsx",
  "accept-invite/page.tsx",
  "forgot-password/page.tsx",
  "login/page.tsx",
  "no-access/page.tsx",
  "reset-password/page.tsx",
  "review/page.tsx",
  "setup/page.tsx",
];

/**
 * The one catch-all page: the host's, which serves contributed views on
 * their own paths behind the `(gui)` layout's redirects. Next.js prefers
 * every other page over it, so a second catch-all would decide which paths
 * reach it.
 */
const CATCH_ALL_PAGES = ["(gui)/[...path]/page.tsx"];

/**
 * The former group name must not appear in any tracked text file. Applied
 * migrations are history and are not edited, and binary files are not text.
 */
function isScanned(file: string): boolean {
  if (file === SELF) return false;
  if (file.startsWith("supabase/migrations/")) return false;
  return !/\.(png|jpe?g|gif|ico|pdf|ttf|woff2?)$/i.test(file);
}

function pages(dir: string, rel = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...pages(path.join(dir, entry.name), relPath));
    } else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(entry.name)) {
      found.push(relPath);
    }
  }
  return found;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

describe("route groups", () => {
  it("has exactly the expected route groups under src/app", () => {
    const groups = readdirSync(APP, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\(.*\)$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(groups).toEqual([...ROUTE_GROUPS].sort());
  });

  it("has no directory left under the former group name", () => {
    expect(existsSync(path.join(APP, FORMER_GROUP))).toBe(false);
  });

  it("keeps every page outside (gui) on the list", () => {
    const outside = pages(APP)
      .filter((page) => !page.startsWith("(gui)/"))
      .sort();
    expect(outside, "A page outside (gui) renders without its layout's redirects").toEqual(
      [...PAGES_OUTSIDE_GUI].sort(),
    );
  });

  it("has only the host's catch-all page, inside (gui)", () => {
    const catchAll = pages(APP).filter((page) => /\[\[?\.\.\./.test(page));
    expect(catchAll.sort()).toEqual(CATCH_ALL_PAGES);
  });

  it("scans configuration and root documents as well as src and docs", () => {
    for (const file of [
      "vitest.config.ts",
      "eslint.config.mjs",
      "next.config.ts",
      "tsconfig.json",
      "Dockerfile",
      "AGENTS.md",
      "SECURITY.md",
      "CLAUDE.md",
      "scripts/budgets/limits.json",
      ".github/CODEOWNERS",
    ]) {
      expect(isScanned(file), file).toBe(true);
    }
    expect(isScanned("supabase/migrations/00001_init.sql")).toBe(false);
    expect(isScanned("public/logo.png")).toBe(false);
  });

  it("has no tracked path under the former group name", () => {
    expect(trackedFiles().filter((file) => file.includes(FORMER_GROUP))).toEqual([]);
  });

  it("does not name the former group in code, configuration or docs", () => {
    const files = trackedFiles().filter(isScanned);
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const file of files) {
      const full = path.join(REPO_ROOT, file);
      if (!existsSync(full)) continue;
      readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (line.includes(FORMER_GROUP)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(offenders, "Name the route group (gui)").toEqual([]);
  });
});
