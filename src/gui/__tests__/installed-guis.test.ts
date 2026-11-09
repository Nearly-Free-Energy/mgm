/**
 * The compiled-in GUIs' metadata (src/gui/meta.ts). The runtime root installs
 * each entry at start-up and refuses one it cannot install, so these checks
 * catch a bad entry here first, with a message that names it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GUI_META } from "@/gui/meta";
import { GUI_CONTRACT } from "@/lib/gui/contract";
import { guiMetaSchema } from "@/lib/gui/host/server/model-schema";
import { satisfiesContract } from "@/lib/gui/host/shared/contract-range";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const GUI_DIR = path.join(REPO_ROOT, "src/gui");

const entries = Object.entries(GUI_META);

const packageDependencies = (): string[] =>
  Object.keys(JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).dependencies ?? {});

describe("compiled-in GUIs", () => {
  it("installs Gridtop", () => {
    expect(Object.keys(GUI_META)).toContain("gridtop");
  });

  it("lists every GUI package that has metadata", () => {
    const packages = readdirSync(GUI_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "__tests__")
      .filter((entry) => existsSync(path.join(GUI_DIR, entry.name, "meta.ts")))
      .map((entry) => entry.name)
      .sort();
    expect(packages).toEqual(Object.keys(GUI_META).sort());
  });

  describe.each(entries)("%s", (key, meta) => {
    it("is keyed by its own name", () => {
      expect(meta.name).toBe(key);
    });

    it("comes from the package directory of that name", async () => {
      const own = (await import(`../${key}/meta.ts`)) as Record<string, unknown>;
      expect(Object.values(own)).toContain(meta);
    });

    it("parses with the host's metadata schema", () => {
      const result = guiMetaSchema.safeParse(meta);
      expect(result.success, result.error?.message).toBe(true);
    });

    it(`supports this build's GUI contract (${GUI_CONTRACT})`, () => {
      expect(satisfiesContract(GUI_CONTRACT, meta.contract)).toBe(true);
    });

    it("names a stylesheet inside its package", () => {
      expect(existsSync(path.join(GUI_DIR, key, meta.styles))).toBe(true);
    });

    it("lists only dependencies declared in package.json", () => {
      const declared = packageDependencies();
      expect(meta.dependencies.filter((name) => !declared.includes(name))).toEqual([]);
    });
  });
});
