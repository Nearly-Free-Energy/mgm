/**
 * Gridtop draws every real example of the usage views with its own
 * renderers, not the kit's fallback: its reader and its row join
 * (src/gui/gridtop/renderers/tenant-usage/ext.ts) accept each model as the
 * server builds it, the New York days with 23 and 25 hours and the month of
 * a person with several units included. Gridtop's own tests may not import
 * these server-only examples (gui-boundary.test.ts, rule 8), so this runs
 * here; the reader is pure TypeScript with no React, which the node project
 * can import. If Gridtop's reader moves or stops being pure, revisit.
 *
 * It also reads the renderer's source for formatting calls: a GUI prints
 * the text the server formatted (CLAUDE.md, design rule 2), and a GUI
 * package's tests may not read files.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readUsageDay, readUsageMonth } from "@/gui/gridtop/renderers/tenant-usage/ext";
import { TENANT_USAGE_DAY_EXAMPLES, TENANT_USAGE_MONTH_EXAMPLES } from "../surface/usage-examples";

const RENDERER = path.resolve(__dirname, "../../../gui/gridtop/renderers/tenant-usage");

describe("Gridtop's tenant usage renderers on the server's examples", () => {
  it.each(TENANT_USAGE_MONTH_EXAMPLES.map((m, i) => [i, m] as const))("reads and joins month example %i", (_, model) => {
    const read = readUsageMonth(model);
    expect(read).not.toBeNull();
    for (const row of model.body.rows) expect(read!.rowOf(row.id)).toBe(row);
  });

  it.each(TENANT_USAGE_DAY_EXAMPLES.map((m, i) => [i, m] as const))("reads and joins day example %i", (_, model) => {
    const read = readUsageDay(model);
    expect(read).not.toBeNull();
    for (const row of model.body.rows) expect(read!.rowOf(row.id)).toBe(row);
  });

  it("includes the 23- and 25-hour days, with a row for each hour up to now and offsets in the labels", () => {
    const lengths = TENANT_USAGE_DAY_EXAMPLES.map((m) => readUsageDay(m)!.ext.hours.length);
    expect(lengths).toContain(23);
    expect(lengths).toContain(25);
    for (const model of TENANT_USAGE_DAY_EXAMPLES) {
      const { ext } = readUsageDay(model)!;
      if (ext.hours.length === 24) continue;
      const past = ext.hours.filter((h) => h.state !== "future");
      expect(model.body.rows).toHaveLength(past.length);
      expect(ext.hours.every((h) => /GMT[+-]\d/.test(h.label))).toBe(true);
      // The labels tell every hour apart, the two 01:00 hours of the long day included.
      expect(new Set(ext.hours.map((h) => h.label)).size).toBe(ext.hours.length);
    }
  });

  it("includes a person with several units, whose every link names the unit", () => {
    const several = TENANT_USAGE_MONTH_EXAMPLES.map((m) => readUsageMonth(m)!.ext).filter((ext) =>
      [ext.previous?.href, ...ext.days.map((d) => d.href)].some((h) => h?.includes("unit=")),
    );
    expect(several).toHaveLength(1);
    const [ext] = several;
    for (const href of [ext.previous?.href, ext.next?.href, ...ext.days.map((d) => d.href)]) {
      if (href) expect(href).toMatch(/[?&]unit=[0-9a-f-]{36}$/);
    }
  });

  it("formats nothing in the renderer: no Intl and no toLocale call", () => {
    const files = readdirSync(RENDERER).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const source = readFileSync(path.join(RENDERER, file), "utf8");
      expect(source, file).not.toMatch(/\bIntl\.|toLocale/);
    }
  });
});
