import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A migration is never edited after it merges to main (docs/operating-model.md,
// Invariants): databases that already ran it keep the old version, and the
// chain then describes a schema no installation has. 00057 and the pilot
// overlay were both edited after NFE's production ran them, which is how
// production and the chain drifted apart. supabase/migrations.sha256 records
// every migration's SHA-256. This test fails when a file changes, appears or
// disappears without its line changing in the same commit, and when a line
// that main already has changes or disappears: editing a merged migration
// and its hash together does not pass.
const root = path.resolve(__dirname, "../../..");
const LIST = "supabase/migrations.sha256";
const MAIN = "origin/main";

function parse(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const match = /^([0-9a-f]{64}) {2}(\S+\.sql)$/.exec(line);
    if (!match) throw new Error(`${LIST}: unreadable line "${line}"`);
    expect(entries.has(match[2]), `${LIST} lists ${match[2]} twice`).toBe(false);
    entries.set(match[2], match[1]);
  }
  return entries;
}

function recorded(): Map<string, string> {
  return parse(readFileSync(path.join(root, LIST), "utf8"));
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// main's copy of the list. null: main has no list yet (before the commit that
// added it merged). The Test workflow fetches origin/main before this runs; a
// local clone without it skips that one check unless CI is set.
function onMain(): Map<string, string> | null | undefined {
  if (git(["rev-parse", "--verify", "--quiet", `${MAIN}^{commit}`]) === null) {
    return undefined;
  }
  const text = git(["show", `${MAIN}:${LIST}`]);
  return text === null ? null : parse(text);
}

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "supabase/migrations/*.sql"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((file) => path.basename(file));
}

function sha256(file: string): string {
  return createHash("sha256")
    .update(readFileSync(path.join(root, "supabase/migrations", file)))
    .digest("hex");
}

describe("migration hashes", () => {
  const list = recorded();
  const files = tracked();

  it("lists every migration file, and only those", () => {
    const missing = files.filter((file) => !list.has(file));
    const gone = [...list.keys()].filter((file) => !files.includes(file));
    expect(
      missing,
      `New migration without a line in ${LIST}. Add it with: shasum -a 256 supabase/migrations/<file> | sed 's#supabase/migrations/##' >> ${LIST}`
    ).toEqual([]);
    expect(
      gone,
      `${LIST} lists files that no longer exist. A merged migration is never deleted: databases that ran it still have its effects`
    ).toEqual([]);
  });

  it("lists them in the order they apply", () => {
    const order = [...list.keys()];
    expect(order).toEqual([...order].sort());
  });

  const main = onMain();

  it.skipIf(main === undefined && !process.env.CI)(
    "keeps every line main already has",
    () => {
      expect(
        main,
        `${MAIN} is not available. CI fetches it before the tests (.github/workflows/test.yml); locally, run: git fetch origin main`
      ).not.toBeUndefined();
      if (!main) return; // main has no list yet
      const changed = [...main].filter(([file, hash]) => list.get(file) !== hash);
      expect(
        changed.map(([file]) => file),
        `These migrations are on main and their line changed or disappeared. A merged migration is never edited or deleted: write a new one`
      ).toEqual([]);
    }
  );

  it.each(files)("%s matches its recorded SHA-256", (file) => {
    expect(
      sha256(file),
      `${file} differs from ${LIST}. Never edit a merged migration: write a new one. While its own pull request is open, update its line in the same commit`
    ).toBe(list.get(file));
  });
});
