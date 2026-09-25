/**
 * Import-boundary test for the community-management plugin (issue #3,
 * Release-1 architectural follow-up).
 *
 * Domain operations (`operations/*.ts`) and the capability consume the
 * `CommunityManagementRepository` interface — never a database client,
 * server helper, or framework module. The Supabase/PostgREST
 * implementation lives in `infrastructure/`, and request wiring lives in
 * `compose.ts`. If either layer reaches past the boundary, the plugin
 * abstraction has leaked and Release 2 would build on a lie.
 *
 * Type-only imports (`import type ...`) are stripped before matching: they
 * carry no runtime dependency.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const GUARDED_RELATIVE = [
  "capability.ts",
  ...readdirSync(path.join(PLUGIN_ROOT, "operations"))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join("operations", entry)),
];

// Runtime import specifiers the domain layer must never touch.
const FORBIDDEN = [
  "@/lib/supabase/",
  "@supabase/",
  "@/lib/auth/",
  "@/lib/plugins/",
  "@/lib/hierarchy",
  "@/components/",
  "next/",
  "cordis",
  "server-only-stub",
];

function runtimeImports(source: string): string[] {
  // Drop type-only imports (erased at compile time — no runtime edge).
  const withoutTypeImports = source.replace(
    /^\s*import\s+type\s[^;]+;/gm,
    ""
  );
  const found: string[] = [];
  const importRe = /from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(withoutTypeImports)) !== null) {
    found.push(match[1]);
  }
  // Bare side-effect imports (e.g. `import "server-only"`) are allowed:
  // they carry no module binding. Only `from` bindings are checked.
  return found;
}

describe("community-management import boundary", () => {
  it("operations and capability import only pure modules + the repository interface", () => {
    const offenders: string[] = [];
    for (const relative of GUARDED_RELATIVE) {
      const text = readFileSync(path.join(PLUGIN_ROOT, relative), "utf8");
      for (const specifier of runtimeImports(text)) {
        if (
          FORBIDDEN.some(
            (denied) =>
              specifier === denied || specifier.startsWith(denied)
          ) &&
          // Relative imports inside the plugin are the boundary itself.
          !specifier.startsWith(".")
        ) {
          offenders.push(`${relative} imports ${specifier}`);
        }
      }
    }
    expect(
      offenders,
      `\nBoundary violations (domain layer reaching past the repository):\n  ${offenders.join("\n  ")}\n` +
        `Move the dependency into infrastructure/ or compose.ts.\n`
    ).toEqual([]);
  });

  it("guards the expected files", () => {
    // If someone moves domain logic to a new file, this list must grow —
    // silently unguarded files defeat the test.
    expect(GUARDED_RELATIVE.sort()).toEqual(
      [
        "capability.ts",
        path.join("operations", "communities.ts"),
        path.join("operations", "households.ts"),
        path.join("operations", "microgrids.ts"),
        path.join("operations", "shared.ts"),
      ].sort()
    );
  });
});
