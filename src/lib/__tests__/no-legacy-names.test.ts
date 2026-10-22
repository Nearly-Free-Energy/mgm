/**
 * MGM is self-contained and named MGM. This test keeps the inherited project
 * name and its private documentation repository from creeping back in.
 *
 * Applied migrations are history and are not scanned. A few live
 * identifiers keep accepting their legacy spelling on purpose; they are
 * listed in LEGACY_COMPAT with the reason, and only there may the legacy
 * spelling appear.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Names that must not appear outside applied migrations. */
const FORBIDDEN = /\bMBE\b|\bmbe\b|mbe-docs|mbe[-:][a-z]|energy-iot|metering-billing-engine/i;

/**
 * The legacy lowercase spelling of a live identifier (`mbe_…` tokens,
 * `mbe_ems_dek`) and the legacy env var. Case-sensitive on purpose: prose
 * "MBE" is never allowed.
 */
const LEGACY_IDENTIFIER = /\bmbe(?:_|\b)|MBE_TOKEN_ENV_PREFIX/;
const LEGACY_IDENTIFIER_ALL = /\bmbe(?:_[A-Za-z_]*)?\b|MBE_TOKEN_ENV_PREFIX/g;

/**
 * Files allowed to mention a legacy identifier, and why. Keep the reasons
 * current: when compatibility is dropped, delete the entry and the mention.
 */
const LEGACY_COMPAT: Record<string, string> = {
  "src/lib/internal-auth.ts": "accepts mbe_ API tokens and reads MBE_TOKEN_ENV_PREFIX as a fallback",
  "src/lib/supabase/__tests__/org_api_tokens.test.ts": "proves legacy mbe_ tokens and the env fallback still work",
  "src/lib/supabase/__tests__/customerapp_enabled.test.ts": "clears the legacy env var between tests",
  "src/lib/supabase/__tests__/internal_auth_401_logging.test.ts": "asserts no legacy token fragment is logged",
  "src/lib/supabase/__tests__/credential_key.test.ts": "documents the legacy key name the migration copies from",
  "src/lib/__tests__/no-legacy-names.test.ts": "this guard",
  "supabase/scripts/retire-legacy-credential-key.sql": "retires the legacy Vault key only after verification",
  "supabase/scripts/rehearse-credential-retirement.sql": "tests retirement of the legacy Vault key",
  "supabase/scripts/rotate-credential-key.sql": "keeps both Vault key names synchronized during rotation",
  "docs/runbooks/dek.md": "explains the legacy key name and how to retire it",
  "docs/customerapp-activation.md": "tells operators that mbe_ tokens stay valid",
};

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((file) => !file.startsWith("supabase/migrations/"))
    .filter((file) => file !== "package-lock.json")
    .filter((file) => !/\.(png|jpe?g|gif|ico|pdf|ttf|woff2?)$/i.test(file));
}

describe("no legacy project names", () => {
  const files = trackedFiles();

  it("scans the repository", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("uses MGM everywhere outside applied migrations", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === "src/lib/__tests__/no-legacy-names.test.ts") continue;
      const lines = readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        const legacyIdentifierOnly =
          Boolean(LEGACY_COMPAT[file]) &&
          LEGACY_IDENTIFIER.test(line) &&
          !FORBIDDEN.test(line.replace(LEGACY_IDENTIFIER_ALL, ""));
        if (FORBIDDEN.test(line) && !legacyIdentifierOnly) {
          offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(offenders, "Use the MGM name; legacy identifiers belong only in LEGACY_COMPAT files").toEqual([]);
  });

  it("keeps legacy identifiers to the files that need them", () => {
    const offenders = files.filter(
      (file) =>
        !LEGACY_COMPAT[file] &&
        LEGACY_IDENTIFIER.test(readFileSync(path.join(REPO_ROOT, file), "utf8"))
    );
    expect(offenders, "Add a reasoned LEGACY_COMPAT entry or use the MGM identifier").toEqual([]);
  });

  it("lists only files that still mention a legacy identifier", () => {
    const stale = Object.keys(LEGACY_COMPAT).filter(
      (file) =>
        file !== "src/lib/__tests__/no-legacy-names.test.ts" &&
        !LEGACY_IDENTIFIER.test(readFileSync(path.join(REPO_ROOT, file), "utf8"))
    );
    expect(stale).toEqual([]);
  });
});
