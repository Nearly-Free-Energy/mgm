/**
 * Browser code never reads the Supabase or application-URL settings from
 * `process.env` (#46, #79). The server reads them at request time
 * (src/lib/config/public-runtime-config.ts, src/lib/config/app-url.ts) and
 * the browser gets the three public values only from
 * PublicRuntimeConfigProvider. A browser read would take whatever value the
 * build had: the deployment that built it would work, and every other
 * installation running that build would log in to the wrong project, or to
 * none.
 *
 * Scans every source file under `src/`, excluding `__tests__/` directories
 * and co-located test files, which are not built, and checks that:
 *   1. no file reads any NEXT_PUBLIC_ name from `process.env`: Next.js
 *      inlines those at build time, so this covers the names retired after
 *      v0.0.2 and any new one;
 *   1a. no file except retired-names.ts, which lists them for the startup
 *      warning, names a retired setting anywhere in code (comments
 *      excepted), so a fallback cannot come back through destructuring, an
 *      alias, `process['env']` or `?.`;
 *   2. only the two config modules read the current settings from
 *      `process.env`;
 *   3. browser files ("use client" modules and the browser-side helpers in
 *      BROWSER_MODULES) name none of the settings, and no NEXT_PUBLIC_ name,
 *      in code, and import only types from the server-only config modules;
 *   4. the server-only config modules import "server-only".
 *
 * Check 3 sees direct imports only. A browser file that reaches a config
 * module through another module is stopped by check 4: `server-only` fails
 * `next build` for any client import, direct or not. Checks 1 and 2 match
 * `process.env.NAME`, `process.env["NAME"]`, `process['env']` and the `?.`
 * forms. They do not match a read through destructuring, an alias or a
 * variable key: for the retired names check 1a covers those, and for a new
 * NEXT_PUBLIC_ name or a current setting read outside the config modules,
 * review has to. If a setting is added, renamed or read by another module,
 * update the lists below.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(REPO_ROOT, "src");
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The only modules that read the current settings from `process.env`. */
const ENV_READERS: Record<string, string> = {
  "src/lib/config/public-runtime-config.ts": "reads and validates the Supabase settings per request",
  "src/lib/config/app-url.ts": "reads and validates MGM_APP_URL per call",
};

/** The one module that may name the retired settings in code: it lists them. */
const RETIRED_LIST = "src/lib/config/retired-names.ts";

/** Server-only modules a browser file may import types from, never values. */
const CONFIG_MODULES = [
  ...Object.keys(ENV_READERS),
  RETIRED_LIST,
];

/** Browser-side modules without a "use client" directive, and why each is one. */
const BROWSER_MODULES: Record<string, string> = {
  "src/lib/supabase/client.ts": "browser Supabase client factory",
  "src/lib/supabase/recovery-client.ts": "browser password-recovery client factory",
  "src/lib/config/browser-config-store.ts": "holds the provider's values for the browser factories",
  "src/lib/config/cookie-options.ts": "shared by the browser factory",
};

const RETIRED =
  "NEXT_PUBLIC_(?:SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_COOKIE_NAME|APP_URL|PAYMENT_CALLBACK_URL)";
const CURRENT = "MGM_PUBLIC_SUPABASE_[A-Z_]+|MGM_APP_URL|SUPABASE_INTERNAL_URL";
const ANY_NEXT_PUBLIC = "NEXT_PUBLIC_[A-Z0-9_]+";

const PROCESS_ENV = `process\\s*(?:\\?\\.\\s*env|\\.\\s*env|\\[\\s*["'\`]env["'\`]\\s*\\])`;
const MEMBER = `\\s*(?:\\?\\.\\s*|\\.\\s*|(?:\\?\\.)?\\[\\s*["'\`])`;
const envRead = (names: string) => new RegExp(`${PROCESS_ENV}${MEMBER}(?:${names})\\b`);
const NEXT_PUBLIC_READ = envRead(`${RETIRED}|${ANY_NEXT_PUBLIC}`);
const CURRENT_READ = envRead(CURRENT);
const SETTING_NAME = new RegExp(`\\b(?:${RETIRED}|${CURRENT}|${ANY_NEXT_PUBLIC})\\b`);
const RETIRED_NAME = new RegExp(`\\b(?:${RETIRED})\\b`);
const USE_CLIENT = /^\s*(["'])use client\1\s*;?\s*$/m;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (stat.isFile() && SOURCE.test(entry) && !TEST.test(entry)) {
      out.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
    }
  }
  return out;
}

const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");

/** Drops block comments and `//` comments, so prose may name a setting. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** Specifiers a module loads at run time; type-only imports are erased. */
function valueImports(source: string): string[] {
  const found: string[] = [];
  const STATIC = /^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gm;
  for (const [, typeOnly, clause, specifier] of source.matchAll(STATIC)) {
    if (typeOnly) continue;
    const named = clause.trim().match(/^\{([\s\S]*)\}$/);
    const allTypes =
      named !== null &&
      named[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .every((part) => part.startsWith("type "));
    if (!allTypes) found.push(specifier);
  }
  for (const [, specifier] of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) {
    found.push(specifier);
  }
  for (const [, specifier] of source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    found.push(specifier);
  }
  return found;
}

/** Repository path of an `@/` or relative specifier, without its extension. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let target: string;
  if (specifier.startsWith("@/")) target = path.posix.join("src", specifier.slice(2));
  else if (specifier.startsWith(".")) target = path.posix.join(path.posix.dirname(fromFile), specifier);
  else return null;
  return target.replace(SOURCE, "");
}

const withoutExtension = (file: string) => file.replace(SOURCE, "");

describe("browser code does not read deployment settings from process.env", () => {
  const files = walk(SRC);
  const browserFiles = files.filter(
    (file) => BROWSER_MODULES[file] !== undefined || USE_CLIENT.test(read(file))
  );

  it("scans the application source and finds the browser files", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(browserFiles.length).toBeGreaterThan(50);
    for (const file of [...Object.keys(BROWSER_MODULES), ...CONFIG_MODULES]) {
      expect(files, `${file} is listed here but no longer exists`).toContain(file);
    }
    expect(browserFiles).toContain("src/lib/config/public-runtime-config-provider.tsx");
  });

  it("reads no NEXT_PUBLIC_ name from process.env", () => {
    const found = files.filter((file) => NEXT_PUBLIC_READ.test(read(file)));
    expect(
      found,
      "Next.js inlines NEXT_PUBLIC_ values at build time; read deployment settings through src/lib/config (the retired names are listed in docs/setup.md, \"Upgrading from v0.0.1 or v0.0.2\")"
    ).toEqual([]);
  });

  it("names a retired setting in code only in the module that lists them", () => {
    const found = files.filter(
      (file) => file !== RETIRED_LIST && RETIRED_NAME.test(stripComments(read(file)))
    );
    expect(
      found,
      "These names are no longer read (docs/setup.md, \"Upgrading from v0.0.1 or v0.0.2\"); use the MGM_ names through src/lib/config"
    ).toEqual([]);
  });

  it("reads the Supabase and application-URL settings only in the config modules", () => {
    const found = files.filter((file) => !ENV_READERS[file] && CURRENT_READ.test(read(file)));
    expect(
      found,
      "Read these settings through src/lib/config/public-runtime-config.ts or app-url.ts"
    ).toEqual([]);
  });

  it("keeps the settings out of browser files", () => {
    const named = browserFiles.filter((file) => SETTING_NAME.test(stripComments(read(file))));
    expect(
      named,
      "Browser code gets these values from PublicRuntimeConfigProvider, never from process.env"
    ).toEqual([]);

    const configModules = new Set(CONFIG_MODULES.map(withoutExtension));
    const importing = browserFiles.flatMap((file) =>
      valueImports(read(file))
        .filter((specifier) => configModules.has(resolveSpecifier(file, specifier) ?? ""))
        .map((specifier) => `${file} imports ${specifier}`)
    );
    expect(importing, "Browser files may import only types from the config modules").toEqual([]);
  });

  it('marks the config modules "server-only"', () => {
    const missing = CONFIG_MODULES.filter(
      (file) => !/^import ["']server-only["'];?$/m.test(read(file))
    );
    expect(missing).toEqual([]);
  });

  it("recognises reads, browser files and value imports", () => {
    expect(NEXT_PUBLIC_READ.test("const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;")).toBe(true);
    expect(NEXT_PUBLIC_READ.test('process.env["NEXT_PUBLIC_PAYMENT_CALLBACK_URL"]')).toBe(true);
    expect(NEXT_PUBLIC_READ.test("process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")).toBe(true);
    expect(NEXT_PUBLIC_READ.test("env[name] // NEXT_PUBLIC_APP_URL")).toBe(false);
    expect(NEXT_PUBLIC_READ.test("process.env.NEXT_PUBLIC_… or process.env.NEXT_PUBLIC_*")).toBe(false);
    expect(CURRENT_READ.test("process.env.MGM_PUBLIC_SUPABASE_ANON_KEY")).toBe(true);
    expect(CURRENT_READ.test("process.env['MGM_APP_URL']")).toBe(true);
    expect(CURRENT_READ.test("process.env.MGM_CREDENTIAL_KEY")).toBe(false);
    expect(NEXT_PUBLIC_READ.test("process['env'].NEXT_PUBLIC_APP_URL")).toBe(true);
    expect(NEXT_PUBLIC_READ.test("process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY")).toBe(true);
    expect(NEXT_PUBLIC_READ.test('process?.env?.["NEXT_PUBLIC_SUPABASE_URL"]')).toBe(true);
    expect(CURRENT_READ.test("process.env?.MGM_APP_URL")).toBe(true);

    // Check 1a: forms checks 1 and 2 cannot see.
    for (const source of [
      "const { NEXT_PUBLIC_APP_URL } = process.env;",
      "const e = process.env; const url = e.NEXT_PUBLIC_SUPABASE_URL;",
      "const url = process['env'].NEXT_PUBLIC_PAYMENT_CALLBACK_URL;",
      "const key = process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY;",
      'const name = "NEXT_PUBLIC_SUPABASE_COOKIE_NAME"; const v = process.env[name];',
    ]) {
      expect(RETIRED_NAME.test(stripComments(source)), source).toBe(true);
    }
    expect(RETIRED_NAME.test(stripComments("// NEXT_PUBLIC_APP_URL is no longer read\nconst x = 1;"))).toBe(false);
    expect(RETIRED_NAME.test(stripComments("/** The former NEXT_PUBLIC_SUPABASE_URL */ const y = 2;"))).toBe(false);
    expect(RETIRED_NAME.test("process.env.NEXT_PUBLIC_SITE_URL")).toBe(false);

    expect(SETTING_NAME.test(stripComments("const { MGM_PUBLIC_SUPABASE_URL } = process.env;"))).toBe(true);
    expect(SETTING_NAME.test(stripComments("// set MGM_APP_URL\nconst x = 1;"))).toBe(false);
    expect(SETTING_NAME.test(stripComments('fetch("https://example.test/x") // MGM_APP_URL'))).toBe(false);

    expect(USE_CLIENT.test('"use client";\n\nimport * as React from "react";')).toBe(true);
    expect(USE_CLIENT.test("'use client'\n")).toBe(true);
    expect(USE_CLIENT.test('const s = "use client in prose";')).toBe(false);

    const from = "src/components/example.tsx";
    const resolved = (source: string) =>
      valueImports(source).map((specifier) => resolveSpecifier(from, specifier));
    expect(resolved('import type { PublicRuntimeConfig } from "@/lib/config/public-runtime-config";')).toEqual([]);
    expect(resolved('import { type PublicRuntimeConfig } from "@/lib/config/public-runtime-config";')).toEqual([]);
    expect(
      resolved('import {\n  getPublicRuntimeConfig,\n  type PublicRuntimeConfig,\n} from "@/lib/config/public-runtime-config";')
    ).toEqual(["src/lib/config/public-runtime-config"]);
    expect(resolved('import { appUrl } from "../lib/config/app-url";')).toEqual(["src/lib/config/app-url"]);
    expect(resolved('import "@/lib/config/app-url";')).toEqual(["src/lib/config/app-url"]);
    expect(resolved('const m = await import("@/lib/config/retired-names");')).toEqual([
      "src/lib/config/retired-names",
    ]);
    expect(resolved('import { createBrowserClient } from "@supabase/ssr";')).toEqual([null]);
  });
});
