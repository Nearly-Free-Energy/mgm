/**
 * The conformance checks, as functions that return findings, so the kit's own
 * tests can run them against broken GUIs. Each renders its fixtures at three
 * widths, so a GUI that drops entries with JavaScript at one width is caught;
 * hiding with CSS renders the same DOM in jsdom and is left to the browser
 * smoke.
 */
import { screen } from "@testing-library/react";
import { isDeepStrictEqual } from "node:util";
import { GUI_META } from "@/gui/meta";
import { setViewportWidth } from "@/test/gui-setup";
import { GUI_CONTRACT, type CoreEntityKind, type EntityRef, type GuiMeta, type GuiPlugin, type Manifest } from "../contract";
import { fillNavHref } from "../host/client/kit-provider";
import { satisfiesContract } from "../host/shared/contract-range";
import { crawl } from "./crawl";
import { MANIFEST_FIXTURES, type ManifestFixture } from "./fixtures/manifests";
import { renderShell, type Rendered } from "./harness";

/** The checks this kit runs so far; the view checks are still to come. */
export type CheckId = "version" | "manifests" | "writes" | "a11y";
export interface Finding {
  check: CheckId;
  fixture: string;
  message: string;
}
export interface CheckOptions {
  /** The installed metadata the GUI must match; GUI_META by default. */
  installed?: Readonly<Record<string, GuiMeta>>;
}
type Check = (gui: GuiPlugin, options?: CheckOptions) => Promise<Finding[]>;

export const WIDTHS = [360, 800, 1366] as const;

/** Renders the Shell for every fixture at every width, and collects what `inspect` reports. */
async function eachShell(
  gui: GuiPlugin,
  inspect: (fixture: ManifestFixture, rendered: Rendered) => Promise<string[]> | string[],
): Promise<{ fixture: string; message: string }[]> {
  const found: { fixture: string; message: string }[] = [];
  for (const fixture of MANIFEST_FIXTURES) {
    for (const width of WIDTHS) {
      setViewportWidth(width);
      const rendered = await renderShell(gui, fixture);
      try {
        for (const message of await inspect(fixture, rendered)) found.push({ fixture: `${fixture.name} at ${width} px`, message });
      } finally {
        rendered.unmount();
      }
    }
  }
  return found;
}

const tag = (check: CheckId, found: { fixture: string; message: string }[]): Finding[] =>
  found.map((f) => ({ check, ...f }));

const META_KEYS = ["name", "title", "version", "contract", "styles", "dependencies"] as const;
const metaOf = (meta: GuiMeta) => Object.fromEntries(META_KEYS.map((key) => [key, meta[key]]));

/** 1. The GUI admits this contract version and matches its installed metadata. */
const version: Check = async (gui, options = {}) => {
  const found: string[] = [];
  let admits = false;
  try {
    admits = satisfiesContract(GUI_CONTRACT, gui.contract);
  } catch {
    // An unsupported range is reported below like one that does not admit the version.
  }
  if (!admits) found.push(`declares contract "${gui.contract}", which does not admit ${GUI_CONTRACT}`);
  const table: Readonly<Record<string, GuiMeta>> = options.installed ?? GUI_META;
  const installed = Object.hasOwn(table, gui.name) ? table[gui.name] : undefined;
  if (!installed) found.push(`"${gui.name}" is not in the installed GUI metadata`);
  else if (!isDeepStrictEqual(metaOf(gui), metaOf(installed))) found.push("differs from its installed metadata (src/gui/meta.ts)");
  return found.map((message) => ({ check: "version", fixture: "metadata", message }));
};

function choicesOf(manifest: Manifest, kind: CoreEntityKind): EntityRef[] {
  if (kind === "organization") return manifest.orgs.map((o) => ({ kind, id: o.id, label: o.name, href: o.href }));
  return manifest.org.places.filter((place) => place.kind === kind);
}

/** 2. Everything the manifest offers is reachable from the Shell. */
const manifests: Check = async (gui) =>
  tag(
    "manifests",
    await eachShell(gui, async ({ manifest, initial, text = [] }, { log }) => {
      const found: string[] = [];
      const reach = await crawl(log);
      const scope = initial.scope;
      for (const entry of manifest.org.nav) {
        const href = fillNavHref(manifest, entry, scope);
        if (href) {
          if (!reach.hrefs.has(href)) found.push(`nav entry ${entry.id} (${href}) is not reachable`);
          continue;
        }
        const kind = entry.needs.find((k) => !scope[k] && k !== "organization");
        const choices = kind ? choicesOf(manifest, kind) : [];
        if (choices.length === 0 && ![...reach.names].some((name) => name.includes(entry.title))) {
          found.push(`nav entry ${entry.id} has no control named "${entry.title}" while it has no place to open`);
        }
        for (const choice of choices) {
          const picked = fillNavHref(manifest, entry, scope, { [kind!]: choice });
          if (picked && !reach.hrefs.has(picked)) found.push(`nav entry ${entry.id} for ${choice.label} (${picked}) is not reachable`);
        }
      }
      for (const item of manifest.org.status) {
        if (!reach.hrefs.has(item.open)) found.push(`status item ${item.id} (${item.open}) is not reachable`);
      }
      for (const org of manifest.orgs) {
        if (org.id !== manifest.org.id && !reach.hrefs.has(org.href)) found.push(`organization ${org.name} (${org.href}) is not reachable`);
      }
      for (const wanted of text) {
        if (!document.body.textContent?.includes(wanted)) found.push(`does not show "${wanted}"`);
      }
      if (log.signOut === 0) found.push("no control reaches kit.SignOut");
      return found;
    }),
  );

/** 6, on mount: rendering writes nothing. Exact refs during use come with the view checks. */
const writes: Check = async (gui) =>
  tag(
    "writes",
    await eachShell(gui, (_, { log }) =>
      log.act.map((ref) => `called kit.act(${ref.action}) without a person asking`),
    ),
  );

const NAMED_ROLES = ["button", "link", "menuitem", "tab", "checkbox", "textbox", "combobox"] as const;

/** 8. Landmarks, names, focus order and the current place. */
const a11y: Check = async (gui) =>
  tag(
    "a11y",
    await eachShell(gui, (_, { pathname }) => {
      const found: string[] = [];
      const mains = screen.queryAllByRole("main").length;
      if (mains !== 1) found.push(`has ${mains} main landmarks, not one`);
      if (screen.queryAllByRole("navigation").length === 0) found.push("has no navigation landmark");
      for (const role of NAMED_ROLES) {
        const unnamed = screen.queryAllByRole(role, { name: "" }).length;
        if (unnamed > 0) found.push(`has ${unnamed} ${role} element(s) without an accessible name`);
      }
      for (const el of document.body.querySelectorAll("[tabindex]")) {
        if (Number(el.getAttribute("tabindex")) > 0) found.push(`sets tabindex="${el.getAttribute("tabindex")}" on a <${el.tagName.toLowerCase()}>`);
      }
      if (document.body.querySelector('[role="tab"][href]')) found.push('gives an element with role="tab" an href');
      for (const link of document.body.querySelectorAll('nav a[href], [role="navigation"] a[href]')) {
        const href = link.getAttribute("href") ?? "";
        if (href.split(/[?#]/, 1)[0] === pathname && !link.hasAttribute("aria-current")) {
          found.push(`links to the current page (${href}) without aria-current`);
        }
      }
      return found;
    }),
  );

export const CHECKS: Readonly<Record<CheckId, Check>> = { version, manifests, writes, a11y };
