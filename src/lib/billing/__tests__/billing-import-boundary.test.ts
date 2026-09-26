/**
 * Import-boundary test for the billing plugin (issue #5).
 *
 * The billing capability and its domain-adjacent modules consume the
 * `BillingRepository` / `BillingGeneration` interfaces only — never a
 * database client, server helper, vendor SDK, or framework module. Vendor
 * and persistence details live in `infrastructure/`, request wiring in
 * `compose.ts`. The MBE bill engine (`generate.ts`, `calculations.ts`,
 * `precision.ts`, `csv-export.ts`) is consumed through the injected
 * delegate, never imported by the capability.
 *
 * Type-only imports (`import type ...`) are stripped before matching: they
 * carry no runtime dependency.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const GUARDED = ["capability.ts", "repository.ts"];

// Runtime import specifiers the domain layer must never touch.
const FORBIDDEN = [
  "@/lib/supabase/",
  "@supabase/",
  "@/lib/auth/",
  "@/lib/plugins/",
  "@/lib/hierarchy",
  "@/lib/openems",
  "@/lib/metering/",
  "@/components/",
  "next/",
  "cordis",
];

function runtimeImports(source: string): string[] {
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
  return found;
}

describe("billing import boundary", () => {
  it("domain files import only pure modules and the repository contract", () => {
    const offenders: string[] = [];
    for (const relative of GUARDED) {
      const text = readFileSync(path.join(PLUGIN_ROOT, relative), "utf8");
      for (const specifier of runtimeImports(text)) {
        if (
          !specifier.startsWith(".") &&
          FORBIDDEN.some(
            (denied) => specifier === denied || specifier.startsWith(denied)
          )
        ) {
          offenders.push(`${relative} imports ${specifier}`);
        }
      }
    }
    expect(
      offenders,
      `\nBoundary violations (billing domain reaching past the repository):\n  ${offenders.join("\n  ")}\n` +
        `Move the dependency into infrastructure/ or compose.ts.\n`
    ).toEqual([]);
  });
});
