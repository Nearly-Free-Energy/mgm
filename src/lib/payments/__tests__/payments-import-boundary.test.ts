/**
 * Payments import boundary.
 *
 * Billing and shared UI call the payment capability — never the provider
 * implementation directly. Pesapal credentials, API types and status
 * mappings stay inside its plugin (`providers/pesapal/` + legacy
 * `pesapal/`). Only the Payments composition root
 * (`compose.ts`, `infrastructure/`, `providers/`) may import them.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function runtimeImports(source: string): string[] {
  const withoutTypeImports = source.replace(/^\s*import\s+type\s[^;]+;/gm, "");
  const found: string[] = [];
  const importRe = /from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(withoutTypeImports)) !== null) {
    found.push(match[1]);
  }
  return found;
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTsFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const COMPAT_ROUTE_SHIMS = new Set([
  // Dual-write shims during rollout: these routes call the capability first
  // and fall back to the legacy community-config flow when capability tables
  // are absent (deploy ordering). They are the only app/ files allowed to
  // import the provider directly; everything else routes through compose.
  "src/app/api/payments/ipn/route.ts",
  "src/app/api/communities/[id]/payment/route.ts",
  "src/app/api/organizations/[id]/payment-accounts/route.ts",
]);

function isAllowedImporter(file: string): boolean {
  const rel = path.relative(REPO_ROOT, file);
  if (COMPAT_ROUTE_SHIMS.has(rel)) return true;
  return (
    rel.startsWith("src/lib/payments/compose.ts") ||
    rel.startsWith("src/lib/payments/capability.ts") ||
    rel.startsWith("src/lib/payments/infrastructure/") ||
    rel.startsWith("src/lib/payments/providers/") ||
    rel.startsWith("src/lib/payments/pesapal/") ||
    // Legacy shims under payments/ root that predate the capability
    // (ensure-payment-link, config, factory) are grandfathered until the
    // compat routes migrate fully — but billing/ and app/ may not use them
    // to reach the provider.
    rel.startsWith("src/lib/payments/__tests__/") ||
    rel.startsWith("src/lib/payments/resolve-org.ts")
  );
}

describe("payments import boundary", () => {
  it("keeps Pesapal imports inside the provider plugin", () => {
    const offenders: string[] = [];
    const roots = [
      path.join(REPO_ROOT, "src", "lib", "billing"),
      path.join(REPO_ROOT, "src", "components"),
      path.join(REPO_ROOT, "src", "app"),
      path.join(REPO_ROOT, "src", "lib", "payments"),
    ];
    for (const root of roots) {
      let files: string[] = [];
      try {
        files = collectTsFiles(root);
      } catch {
        continue;
      }
      for (const file of files) {
        if (isAllowedImporter(file)) continue;
        // Capability-adjacent pure modules may not touch the provider either.
        const rel = path.relative(REPO_ROOT, file);
        const isPaymentsDomain =
          rel === "src/lib/payments/repository.ts" ||
          rel === "src/lib/payments/reconciliation.ts" ||
          rel === "src/lib/payments/scope.ts";
        const text = readFileSync(file, "utf8");
        for (const specifier of runtimeImports(text)) {
          const touchesPesapal =
            specifier.includes("/payments/pesapal") ||
            specifier.includes("/providers/pesapal") ||
            specifier === "@/lib/payments/pesapal" ||
            /pesapal\/client|pesapal\/index|pesapal\/build-params/.test(specifier);
          if (touchesPesapal) {
            offenders.push(`${rel} imports ${specifier}`);
          }
          if (isPaymentsDomain) {
            const forbidden =
              specifier.startsWith("@/lib/supabase/") ||
              specifier.startsWith("@supabase/") ||
              specifier.startsWith("@/lib/auth/") ||
              specifier.startsWith("@/lib/plugins/") ||
              specifier === "cordis" ||
              specifier.startsWith("next/");
            if (forbidden && !specifier.startsWith(".")) {
              offenders.push(`${rel} imports ${specifier}`);
            }
          }
        }
      }
    }
    expect(
      offenders,
      `\nBoundary violations (provider leak past the capability):\n  ${offenders.join("\n  ")}\n` +
        `Route billing/invoice/payment-link code through composePayments + the capability.\n`
    ).toEqual([]);
  });
});
