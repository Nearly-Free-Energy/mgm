/**
 * Import boundary of the tenant app (RFC mgm#197 § 3).
 *
 * The capability, its types and its pure helpers (the usage calendar and the
 * usage cache and limit) consume the `TenantAppRepository` and
 * `TenantUsageSource` interfaces only: never a database client, the service
 * role, an access helper, plugin state, a vendor client or the metering
 * providers. The tenant's own client lives in
 * `infrastructure/supabase-repository.ts`, request wiring in `compose.ts`,
 * so what the capability reads from the database is what the tenant's
 * row-level access allows. `infrastructure/usage-source.ts` is the one place
 * that reaches the service role, the metering gate and the metering
 * providers; `compose.ts` wires it in TenantAppPlugin, which loads only after
 * authorizeTenant (service-role-session-check.test.ts lists both).
 *
 * Type-only imports (`import type ...`) are stripped before matching: they
 * carry no runtime dependency.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const GUARDED = [
  "capability.ts",
  "types.ts",
  "usage-calendar.ts",
  "usage-throttle.ts",
  "infrastructure/supabase-repository.ts",
];

/** Runtime import specifiers the guarded files must never touch. */
const FORBIDDEN = [
  "@/lib/supabase/",
  "@/lib/auth/",
  "@/lib/plugins/",
  "@/lib/openems",
  "@/lib/metering",
  "@/lib/runtime",
  "@/components/",
  "next/",
  "cordis",
];

/** Allowed only in infrastructure/, which is handed the tenant's own client. */
const CLIENT = "@supabase/";

function runtimeImports(source: string): string[] {
  const withoutTypeImports = source.replace(/^\s*import\s+type\s[^;]+;/gm, "");
  return [...withoutTypeImports.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

describe("tenant app import boundary", () => {
  it("keeps the capability and its types behind the repository", () => {
    const offenders: string[] = [];
    for (const relative of GUARDED) {
      const text = readFileSync(path.join(PLUGIN_ROOT, relative), "utf8");
      const denied = relative.startsWith("infrastructure/") ? FORBIDDEN : [...FORBIDDEN, CLIENT];
      for (const specifier of runtimeImports(text)) {
        if (!specifier.startsWith(".") && denied.some((d) => specifier === d || specifier.startsWith(d))) {
          offenders.push(`${relative} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
