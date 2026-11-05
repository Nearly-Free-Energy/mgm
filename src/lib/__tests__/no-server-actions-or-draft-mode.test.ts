/**
 * Keeps Server Actions ("use server" directives) and Next.js draft mode
 * (`draftMode`) out of the source until the hosting environment is ready for
 * them.
 *
 * Published release assets are built without installation settings
 * (scripts/release/build-deploy-asset.sh, docs/releasing.md), so before
 * introducing either feature, set NEXT_SERVER_ACTIONS_ENCRYPTION_KEY (and a
 * fixed preview-mode configuration if draft mode is used) in the hosting
 * environment. Then narrow or remove this test in the same pull request.
 *
 * This holds only while releases ship as assets built ahead of deployment
 * from no installation's settings, and while Next.js reads
 * NEXT_SERVER_ACTIONS_ENCRYPTION_KEY at run time. If either changes, or
 * Next.js adds a way to define a Server Action or enter draft mode that the
 * patterns below do not match, revisit.
 *
 * Scans every source file under `src/`, excluding `__tests__/` directories
 * and co-located test files, which are not part of the build.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(REPO_ROOT, "src");
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

// A directive is a string-literal statement at the start of a file or of a
// function body: after the start of a line, a `{` or a `;`.
const USE_SERVER = /(?:^|[{;])\s*(["'])use server\1/m;
// `draftMode()` from next/headers, and the Pages Router's `setDraftMode`.
const DRAFT_MODE = /\b(?:draftMode|setDraftMode)\b/;

const ADVICE =
  "Published release assets are built without installation settings, so before introducing " +
  "Server Actions or draft mode, set NEXT_SERVER_ACTIONS_ENCRYPTION_KEY (and a fixed preview-mode " +
  "configuration if draft mode is used) in the hosting environment, then update this test. " +
  "See docs/releasing.md.";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (stat.isFile() && SOURCE.test(entry) && !TEST.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function offenders(files: string[], pattern: RegExp): string[] {
  return files
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(REPO_ROOT, file));
}

describe("no Server Actions or draft mode in the source", () => {
  const files = walk(SRC);

  it("scans the application source", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('source files have no "use server" directive', () => {
    const found = offenders(files, USE_SERVER);
    expect(found, `\nFound a "use server" directive in:\n  ${found.join("\n  ")}\n${ADVICE}`).toEqual([]);
  });

  it("source files do not use draft mode", () => {
    const found = offenders(files, DRAFT_MODE);
    expect(found, `\nFound draftMode in:\n  ${found.join("\n  ")}\n${ADVICE}`).toEqual([]);
  });

  it("recognises both features", () => {
    for (const text of [
      '"use server";\nexport async function save() {}',
      "export async function save() {\n  'use server';\n}",
      "const save = async () => { \"use server\"; };",
    ]) {
      expect(USE_SERVER.test(text), text).toBe(true);
    }
    expect(USE_SERVER.test('// a comment that mentions "use server"')).toBe(false);
    expect(USE_SERVER.test('"use client";')).toBe(false);
    expect(DRAFT_MODE.test("const { isEnabled } = await draftMode();")).toBe(true);
    expect(DRAFT_MODE.test("res.setDraftMode({ enable: true });")).toBe(true);
  });
});
