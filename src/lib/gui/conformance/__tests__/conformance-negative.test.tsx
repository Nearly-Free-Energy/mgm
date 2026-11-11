/**
 * Each check fails a GUI broken in the way it guards, and no other check
 * does, so a check that cannot fail is caught here.
 */
import { useEffect, useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";
import type { GuiMeta, GuiPlugin, ViewProps } from "../../contract";
import { kit } from "../../kit";
import { CHECKS, type CheckId, type CheckOptions, type Finding } from "../checks";
import { registerConformance } from "../describe";
import { REFERENCE_META, referenceGui } from "./reference-gui";

async function findings(gui: GuiPlugin): Promise<Finding[]> {
  // Installed as declared, so a bad range is the only finding of its case.
  const installed = { reference: { ...REFERENCE_META, contract: gui.contract } };
  const all: Finding[] = [];
  for (const check of Object.values(CHECKS)) all.push(...(await check(gui, { installed })));
  return all;
}

const withView = (View: GuiPlugin["View"]): GuiPlugin => ({ ...referenceGui(), View });

function ActsInEffect({ model }: ViewProps) {
  useEffect(() => void kit.act(model.actions[0]), [model]);
  return <kit.KitView model={model} />;
}
function ActsInLayoutEffect({ model }: ViewProps) {
  useLayoutEffect(() => void kit.act(model.actions[0]), [model]);
  return <kit.KitView model={model} />;
}
function ActsInRender({ model }: ViewProps) {
  void kit.act(model.actions[0]);
  return <kit.KitView model={model} />;
}
function ActsLater({ model }: ViewProps) {
  useEffect(() => {
    // Two timers deep, past the one act() itself waits for.
    let inner: ReturnType<typeof setTimeout> | undefined;
    const outer = setTimeout(() => {
      inner = setTimeout(() => void kit.act(model.actions[0]), 0);
    }, 0);
    return () => {
      clearTimeout(outer);
      clearTimeout(inner);
    };
  }, [model]);
  return <kit.KitView model={model} />;
}

const BROKEN: [CheckId, string, GuiPlugin, RegExp][] = [
  ["version", "declares a contract range that leaves this version out", { ...referenceGui(), contract: "^0.2" }, /does not admit/],
  ["version", "declares a range the host cannot read", { ...referenceGui(), contract: ">=0.1" }, /does not admit/],
  ["version", "is not installed", { ...referenceGui(), name: "absent" }, /not in the installed GUI metadata/],
  ["manifests", "leaves out a nav entry", referenceGui({ dropNav: "community.communities" }), /nav entry community\.communities/],
  ["manifests", "offers no place for an entry that needs one", referenceGui({ noChoices: true }), /for (First|Second) site/],
  ["manifests", "shows nothing for an entry with no place", referenceGui({ noPlaceControl: true }), /no control named "(Operations|Billing)"/],
  ["manifests", "leaves out the status items", referenceGui({ noStatus: true }), /status item community\.setup/],
  ["manifests", "leaves out the organization switcher", referenceGui({ noOrgSwitch: true }), /organization Second organization/],
  ["manifests", "does not show an unknown entry's title", referenceGui({ hideUnknownTitle: true }), /does not show "Tickets"/],
  ["manifests", "has no sign-out", referenceGui({ noSignOut: true }), /kit\.SignOut/],
  ["writes", "acts in an effect", withView(ActsInEffect), /kit\.act\(community\.rename\)/],
  ["writes", "acts in a layout effect", withView(ActsInLayoutEffect), /kit\.act\(community\.rename\)/],
  ["writes", "acts while it renders", withView(ActsInRender), /kit\.act\(community\.rename\)/],
  ["writes", "acts after a timer", withView(ActsLater), /kit\.act\(community\.rename\)/],
  ["a11y", "has no main landmark", referenceGui({ noMain: true }), /0 main landmarks/],
  ["a11y", "has two main landmarks", referenceGui({ twoMains: true }), /2 main landmarks/],
  ["a11y", "has no navigation landmark", referenceGui({ noNav: true }), /no navigation landmark/],
  ["a11y", "has a button without a name", referenceGui({ unnamedButton: true }), /1 button element\(s\) without an accessible name/],
  ["a11y", "sets a positive tabindex", referenceGui({ positiveTabIndex: true }), /tabindex="1"/],
  ["a11y", "gives a tab an href", referenceGui({ tabWithHref: true }), /role="tab"/],
  ["a11y", "does not mark the current page", referenceGui({ noCurrent: true }), /without aria-current/],
];

describe("each check fails a GUI broken in the way it guards", () => {
  it.each(BROKEN)("%s: a GUI that %s", async (check, _, gui, message) => {
    const found = await findings(gui);
    expect([...new Set(found.map((f) => f.check))]).toEqual([check]);
    for (const f of found) expect(f.message).toMatch(message);
  });

  it("manifests: a GUI that drops status items at one width only, at that width", async () => {
    const found = await findings(referenceGui({ narrowNoStatus: true }));
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(`${f.check} ${f.fixture} ${f.message}`).toMatch(/^manifests .* at 360 px status item/);
  });

  it.each([["name", "other"], ["title", "Other"], ["version", "0.0.1"], ["contract", "^0.1.0"], ["styles", "./other.css"], ["dependencies", ["x"]]] as const)(
    "version: a GUI whose %s differs from its installed entry",
    async (key, value) => {
      const gui = { ...referenceGui(), [key]: value } as GuiPlugin;
      const installed: Record<string, GuiMeta> = { [gui.name]: REFERENCE_META };
      expect((await CHECKS.version(gui, { installed })).map((f) => f.message)).toEqual([
        "differs from its installed metadata (src/gui/meta.ts)",
      ]);
    },
  );

  it("passes the reference GUI with no findings", async () => {
    expect(await findings(referenceGui())).toEqual([]);
  });
});

describe("describeGuiConformance", () => {
  /** The cases registerConformance (what describeGuiConformance calls) registers. */
  function cases(gui: GuiPlugin, options: CheckOptions) {
    const found: { name: string; run: () => Promise<void> }[] = [];
    registerConformance(gui, options, { describe: (_, body) => body(), it: (name, run) => void found.push({ name, run }) });
    return found;
  }
  const installed = { reference: REFERENCE_META };

  it("registers one case per check, and fails the case of the broken check only", async () => {
    const registered = cases(referenceGui({ noMain: true }), { installed });
    expect(registered.map((c) => c.name)).toEqual(Object.keys(CHECKS));
    for (const { name, run } of registered) {
      if (name === "a11y") await expect(run()).rejects.toThrow(/0 main landmarks/);
      else await expect(run()).resolves.toBeUndefined();
    }
  });

  it("checks against GUI_META when no table is given", async () => {
    const [version] = cases(referenceGui(), {});
    await expect(version.run()).rejects.toThrow(/not in the installed GUI metadata/);
  });
});
