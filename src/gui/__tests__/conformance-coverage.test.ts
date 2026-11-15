/**
 * Every compiled-in GUI runs the conformance kit: each entry in GUI_META,
 * the default included, has a test file in its own package that calls
 * describeGuiConformance with the plugin its package entry exports, as a
 * top-level statement, so the call cannot sit inside a skipped or
 * conditional block. Reads source text only; it does not run the kit.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { INSTALLED_GUIS } from "@/gui/installed";
import { GUI_META, type GuiName } from "@/gui/meta";
import { DEFAULT_GUI } from "@/lib/config/gui";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const GUI_DIR = path.join(REPO_ROOT, "src/gui");
const KIT = "@/lib/gui/conformance";
const TEST = /\.test\.tsx?$/;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(full);
    return TEST.test(entry.name) ? [full] : [];
  });
}

/** Whether `specifier`, imported by `file`, names the package entry src/gui/<name>/index.ts(x). */
function isPackageEntry(specifier: string, file: string, name: string): boolean {
  if (specifier === `@/gui/${name}` || specifier === `@/gui/${name}/index`) return true;
  if (!specifier.startsWith(".")) return false;
  const resolved = path.resolve(path.dirname(file), specifier).replace(/\/index$/, "");
  return resolved === path.join(GUI_DIR, name);
}

/**
 * Whether the test file `file` calls describeGuiConformance, imported from
 * the kit, at top level with the identifier it imported as `exportName` from
 * GUI `name`'s package entry.
 */
export function callsConformance(source: string, file: string, name: string, exportName: string): boolean {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let kitLocal: string | null = null;
  const guiLocals = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    // A package entry may export its plugin as its default.
    if (clause.name && exportName === "default" && isPackageEntry(specifier, file, name)) guiLocals.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (specifier === KIT && imported === "describeGuiConformance") kitLocal = element.name.text;
      if (imported === exportName && isPackageEntry(specifier, file, name)) guiLocals.add(element.name.text);
    }
  }
  if (!kitLocal) return false;
  return sf.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const { expression: callee, arguments: args } = statement.expression;
    return (
      ts.isIdentifier(callee) &&
      callee.text === kitLocal &&
      args.length === 1 &&
      ts.isIdentifier(args[0]) &&
      guiLocals.has(args[0].text)
    );
  });
}

/** The name under which GUI `name`'s package entry exports its INSTALLED_GUIS plugin. */
async function entryExportName(name: GuiName): Promise<string | undefined> {
  // Resolved without an extension, as src/gui/installed.ts imports it, so an
  // index.ts or an index.tsx entry both load.
  const entry = (await import(`../${name}`)) as Record<string, unknown>;
  return Object.keys(entry).find((key) => entry[key] === INSTALLED_GUIS[name]);
}

describe("conformance coverage", () => {
  it("includes the default GUI among the compiled-in ones", () => {
    expect(Object.keys(GUI_META)).toContain(DEFAULT_GUI);
  });

  it.each(Object.keys(GUI_META) as GuiName[])("%s has a test file that runs describeGuiConformance on it", async (name) => {
    const exportName = await entryExportName(name);
    expect(exportName, `src/gui/${name}/index.ts exports INSTALLED_GUIS.${name}`).toBeDefined();
    const covering = testFiles(path.join(GUI_DIR, name)).filter((file) =>
      callsConformance(readFileSync(file, "utf8"), file, name, exportName!),
    );
    expect(covering.map((file) => path.relative(REPO_ROOT, file)), `a test under src/gui/${name}/ calls describeGuiConformance(${exportName})`).not.toEqual([]);
  });

  describe("the check itself", () => {
    const file = path.join(GUI_DIR, "probe/__tests__/conformance.test.tsx");
    const kit = `import { describeGuiConformance } from "${KIT}";\n`;
    const gui = 'import { ProbeGui } from "..";\n';
    const holds = (source: string) => callsConformance(source, file, "probe", "ProbeGui");

    it("accepts a top-level call with the package entry's plugin, aliases included", () => {
      expect(holds(`${kit}${gui}describeGuiConformance(ProbeGui);`)).toBe(true);
      expect(holds(`import { describeGuiConformance as run } from "${KIT}";\nimport { ProbeGui as G } from "@/gui/probe";\nrun(G);`)).toBe(true);
    });

    it("accepts a package entry that exports its plugin as its default", () => {
      const fromDefault = (source: string) => callsConformance(source, file, "probe", "default");
      expect(fromDefault(`${kit}import Probe from "..";\ndescribeGuiConformance(Probe);`)).toBe(true);
      expect(fromDefault(`${kit}import Probe from "../other";\ndescribeGuiConformance(Probe);`)).toBe(false);
    });

    it("refuses a missing, nested, commented or mis-targeted call", () => {
      expect(holds(`${kit}${gui}`)).toBe(false);
      expect(holds(`${kit}${gui}describe.skip("x", () => { describeGuiConformance(ProbeGui); });`)).toBe(false);
      expect(holds(`${kit}${gui}if (false) describeGuiConformance(ProbeGui);`)).toBe(false);
      expect(holds(`${kit}${gui}// describeGuiConformance(ProbeGui);`)).toBe(false);
      expect(holds(`${kit}import { ProbeGui } from "../other";\ndescribeGuiConformance(ProbeGui);`)).toBe(false);
      expect(holds(`${kit}import { OtherGui } from "..";\ndescribeGuiConformance(OtherGui);`)).toBe(false);
      expect(holds(`import { describeGuiConformance } from "./local-copy";\n${gui}describeGuiConformance(ProbeGui);`)).toBe(false);
    });
  });
});
