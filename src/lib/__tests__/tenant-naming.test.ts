/**
 * A microgrid's customer is a tenant (docs/entity-model.md, "Naming").
 * 20261116230000_rename_households_to_tenants.sql renamed every database
 * object that called it a household, and the code, URLs and copy followed.
 * This test keeps the old word from coming back.
 *
 * Applied migrations are history and are not scanned, and neither is the
 * checksum list that names them. A few files keep the old word on purpose;
 * they are listed in KEEPS_OLD_NAME with the reason, and only there may it
 * appear.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const OLD_NAME = /household/i;

/**
 * Files allowed to use the old name, and why. Keep the reasons current:
 * when a reason stops holding, delete the entry and the mention.
 */
const KEEPS_OLD_NAME: Record<string, string> = {
  "CLAUDE.md": "records the schema's history",
  "docs/entity-model.md": "records the old name and what the rename changed",
  "src/lib/billing/audit-log-fetch.ts": "reads the household_name snapshot that bills generated before the rename keep",
  "src/lib/billing/audit-humanize.tsx": "reads the household_name snapshot that bills generated before the rename keep",
  "src/lib/billing/__tests__/audit-humanize.test.tsx": "proves the household_name snapshot still resolves",
  "src/app/api/billing-periods/[periodId]/audit-log/__tests__/route.test.ts":
    "proves the household_name snapshot still resolves",
  "src/middleware.ts": "sends the old tenant page URLs to the new ones",
  "src/lib/__tests__/middleware.test.ts": "proves the old tenant page URLs redirect",
  "src/lib/supabase/__tests__/tenants_phone_required.test.ts": "names migration 00024 by its file name",
  "supabase/scripts/rehearse-release3.sql": "rehearses 00064 on the pilot schema of its day",
  "supabase/scripts/rehearse-pilot-user-directory.sql":
    "rehearses 20261103090000 on the pilot schema of its day",
  "src/lib/__tests__/tenant-naming.test.ts": "this guard",
};

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((file) => !file.startsWith("supabase/migrations/"))
    .filter((file) => file !== "supabase/migrations.sha256")
    .filter((file) => file !== "package-lock.json")
    .filter((file) => !/\.(png|jpe?g|gif|ico|pdf|ttf|woff2?)$/i.test(file));
}

describe("tenant, not household", () => {
  const files = trackedFiles();

  it("scans the repository", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("names no file or directory after households", () => {
    expect(files.filter((file) => OLD_NAME.test(file))).toEqual([]);
  });

  it("uses the old name only where KEEPS_OLD_NAME says why", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (KEEPS_OLD_NAME[file]) continue;
      const lines = readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (OLD_NAME.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(offenders, "Say tenant; the old name belongs only in KEEPS_OLD_NAME files").toEqual([]);
  });

  it("lists only files that exist and still use the old name", () => {
    const stale = Object.keys(KEEPS_OLD_NAME).filter((file) => {
      if (!files.includes(file)) return true;
      return !OLD_NAME.test(readFileSync(path.join(REPO_ROOT, file), "utf8"));
    });
    expect(stale).toEqual([]);
  });
});
