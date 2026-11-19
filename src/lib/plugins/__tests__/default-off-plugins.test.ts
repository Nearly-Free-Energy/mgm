/**
 * The plugin catalog (bundled.ts) against the plugin lists the database keeps
 * in its migrations. Two sides answer "which plugins exist" and "is this
 * plugin on without a state row", and nothing else keeps them in step:
 *
 *   - `mgm_plugins_name_known`, `mgm_plugin_audit_log_plugin_known` and
 *     `fn_mgm_set_plugin_enabled` name every bundled plugin, so a plugin
 *     missing there cannot be turned on or off;
 *   - `mgm_plugin_enabled_for_org` answers a missing row with the plugin's
 *     default, and the plugins it lists as off by default are the catalog's
 *     `defaultEnabled: false` plugins. The gate, the GUI host and the
 *     composers read that function; Settings → Plugins reads the catalog. A
 *     difference would show a plugin as off in Settings while the gate lets
 *     it through, or the reverse.
 *
 * Each list is read from the newest migration that defines it, so the test
 * needs no database and runs in every CI job. A migration that redefines one
 * of them in another shape fails here until the parser below learns it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_OFF_PLUGIN_NAMES, MGM_BUNDLED_PLUGINS } from "../bundled";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8") }));

/** The newest migration whose SQL matches `pattern`, with the match. */
function newest(pattern: RegExp): { file: string; sql: string; match: RegExpExecArray } {
  for (let i = migrations.length - 1; i >= 0; i--) {
    const match = pattern.exec(migrations[i].sql);
    if (match) return { ...migrations[i], match };
  }
  throw new Error(`No migration matches ${pattern}`);
}

/** The single-quoted names in an SQL list body such as "'a', 'b'". */
function quoted(list: string): string[] {
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/** The body of the newest `CREATE OR REPLACE FUNCTION <name>(…) … AS $$ … $$`. */
function functionBody(name: string): { file: string; body: string } {
  const { file, sql, match } = newest(
    new RegExp(`CREATE OR REPLACE FUNCTION\\s+(?:public\\.)?${name}\\s*\\(`)
  );
  const rest = sql.slice(match.index);
  const body = /AS\s+\$\$([\s\S]*?)\$\$/.exec(rest);
  if (!body) throw new Error(`${file}: could not find the body of ${name}`);
  return { file, body: body[1] };
}

const bundledNames = MGM_BUNDLED_PLUGINS.map((plugin) => plugin.name).sort();

describe("the database's plugin lists", () => {
  it.each(["mgm_plugins_name_known", "mgm_plugin_audit_log_plugin_known"])(
    "%s names every bundled plugin",
    (constraint) => {
      const { file, match } = newest(
        new RegExp(`CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(\\s*plugin_name\\s+IN\\s*\\(([^)]*)\\)`)
      );
      expect(quoted(match[1]), file).toEqual(bundledNames);
    }
  );

  it("fn_mgm_set_plugin_enabled accepts every bundled plugin", () => {
    const { file, body } = functionBody("fn_mgm_set_plugin_enabled");
    const list = /_plugin_name\s+NOT\s+IN\s*\(([^)]*)\)/.exec(body);
    if (!list) throw new Error(`${file}: fn_mgm_set_plugin_enabled no longer lists plugin names`);
    expect(quoted(list[1]), file).toEqual(bundledNames);
  });

  it("mgm_plugin_enabled_for_org counts a missing row as off for exactly the catalog's default-off plugins", () => {
    const { file, body } = functionBody("mgm_plugin_enabled_for_org");
    // Two shapes: every plugin on without a row (00056), or a list of the
    // plugins that are off without one, as the COALESCE fallback.
    const list = /COALESCE\s*\([\s\S]*,\s*_plugin_name\s+NOT\s+IN\s*\(([^)]*)\)\s*\)/.exec(body);
    const allOn = /COALESCE\s*\([\s\S]*,\s*TRUE\s*\)/i.test(body);
    if (!list && !allOn) {
      throw new Error(`${file}: mgm_plugin_enabled_for_org has a missing-row default this test cannot read`);
    }
    expect(list ? quoted(list[1]) : [], file).toEqual([...DEFAULT_OFF_PLUGIN_NAMES].sort());
  });
});
