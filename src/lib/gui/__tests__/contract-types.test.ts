/**
 * Compile-time checks of the GUI contract (src/lib/gui/contract.ts and
 * surface.ts). `npx tsc --noEmit` type-checks this file: each line under a
 * `@ts-expect-error` must fail to compile, and tsc reports a directive whose
 * line compiles. Vitest runs the rest. The Test gate runs tsc before the
 * tests; if it stops doing so, these cases are no longer checked.
 *
 * These rules are aids. The widened-boolean case below compiles, so anything
 * that registers a contribution must check the rules again at run time.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  GUI_CONTRACT,
  GUI_KINDS_SINCE,
  type CoreEntityKind,
  type GuiKit,
  type GuiPlugin,
  type Href,
  type Signal,
  type ViewKind,
} from "../contract";
import type {
  ActionDef,
  Contribution,
  LoadedModel,
  NavDef,
  Prepare,
  ProposableAction,
  ViewDef,
} from "../surface";
import type { GateTarget } from "@/lib/runtime/gate";
import { BILLING_SURFACE } from "./fixtures/billing-surface";

/** Checks `value` against T where the call is written. */
function accept<T>(value: T): T {
  return value;
}

const prepare: Prepare = async () => ({ ok: false, status: 503, message: "fixture" });
const base = {
  id: "billing.x",
  title: "X",
  target: "billingPeriod",
  input: z.strictObject({}),
  inputVersion: 1,
  path: "/api/billing-periods/[periodId]",
  bind: {},
} as const;
// Referenced only inside a loader the test never calls.
declare const recordModel: LoadedModel<"record">;

/** The compiler accepts a humanOnly that is only known to be a boolean. */
function widened(flag: boolean): ActionDef {
  return { ...base, method: "POST", risk: "money", humanOnly: flag, confirm: "none" };
}

/** A GUI with the least it must provide, built from a kit. */
function minimalGui(kit: GuiKit) {
  return {
    name: "probe",
    title: "Probe",
    version: "0.1.0",
    contract: "^0.1",
    styles: "./probe.css",
    dependencies: [],
    Shell: ({ children }) => children,
    View: kit.KitView,
  } satisfies GuiPlugin;
}

function versionParts(version: string): number[] {
  return version.split(".").map(Number);
}

describe("GUI contract types", () => {
  // Each case breaks only the rule it names, so loosening that rule leaves
  // its directive unused and tsc fails.
  it("refuses an action whose confirmation level breaks a rule", () => {
    // @ts-expect-error a DELETE is never proposable
    accept<ProposableAction>({ ...base, method: "DELETE", risk: "money", humanOnly: false, confirm: "confirm" });
    // @ts-expect-error a destructive action is never proposable
    accept<ProposableAction>({ ...base, method: "POST", risk: "destructive", humanOnly: false, confirm: "confirm" });
    // @ts-expect-error a ceremony needs prepare
    accept<ActionDef>({ ...base, method: "POST", risk: "money", humanOnly: true, confirm: "ceremony" });
    // @ts-expect-error a typed action is human-only
    accept<ActionDef>({ ...base, method: "POST", risk: "money", humanOnly: false, confirm: "typed", prepare });
    // @ts-expect-error an external action shows who is contacted, through prepare
    accept<ActionDef>({ ...base, method: "POST", risk: "external", humanOnly: false, confirm: "confirm" });
    // @ts-expect-error an external action is confirmed at least
    accept<ActionDef>({ ...base, method: "POST", risk: "external", humanOnly: false, confirm: "none", prepare });
    // @ts-expect-error a DELETE needs a typed or ceremony confirmation, even with prepare
    accept<ActionDef>({ ...base, method: "DELETE", risk: "write", humanOnly: true, confirm: "confirm", prepare });
  });

  it("compiles a widened humanOnly, which is why the rules need a run-time check too", () => {
    expect(widened(true).humanOnly).toBe(true);
  });

  it("refuses a loader whose model is not its view's kind", () => {
    // @ts-expect-error a collection view's loader returns a collection model
    accept<ViewDef>({
      id: "billing.periods",
      kind: "collection",
      path: "/microgrids/[id]/billing",
      params: { id: "microgrid" },
      cost: "db",
      declares: { keys: [] },
      examples: [],
      load: async () => ({ ok: true, model: recordModel }),
    });
  });

  it("refuses a View that renders asynchronously", () => {
    accept<GuiPlugin>({
      name: "x",
      title: "X",
      version: "0.1.0",
      contract: "^0.1",
      styles: "./x.css",
      dependencies: [],
      Shell: () => null,
      // @ts-expect-error a View renders synchronously, so it also works in the browser and in jsdom
      View: async () => null,
    });
  });

  it("refuses an absolute URL as an Href", () => {
    // @ts-expect-error an Href starts with "/"
    accept<Href>("https://example.com/x");
  });

  it("still compiles a protocol-relative or backslash Href, so the host must check at run time", () => {
    // The type guarantees only a leading "/". Browsers send both of these
    // off-site, and the host's Href schema refuses them (#124). If a later
    // type refuses them too, these lines fail to compile: then update the
    // Href comment in contract.ts.
    accept<Href>("//evil.example/x");
    accept<Href>("/\\evil.example");
  });

  it("refuses an absolute URL as a legacy nav entry's href", () => {
    accept<NavDef>({
      id: "billing.rates",
      title: "Rates",
      icon: "billing",
      group: "configure",
      order: 1,
      // @ts-expect-error a legacy nav href is an Href
      href: "https://example.com/rates",
      needs: ["microgrid"],
      legacy: true,
    });
  });

  it("refuses a your-move signal that carries an action", () => {
    accept<Signal>({
      id: "1",
      source: "billing.period-due",
      kind: "your-move",
      severity: "warn",
      title: "October ended",
      href: "/",
      at: "2026-11-06T11:32:00Z",
      // @ts-expect-error a your-move signal links to its step and never carries an action
      action: { action: "billing.close-period", params: {}, label: "Close", enabled: true },
    });
  });

  it("refuses a contribution with an unknown key or plugin", () => {
    accept<Contribution>({
      plugin: "billing",
      // @ts-expect-error a contribution has no other keys
      nonsense: true,
    });
    accept<Contribution>({
      // @ts-expect-error a contribution names a plugin in the catalog
      plugin: "acme",
    });
  });

  it("accepts the billing fixture and a minimal GUI", () => {
    // The fixture is declared `: Contribution`, and tsc type-checks that file,
    // so the declaration is the billing check. The GUI must stay assignable
    // once its own literal type is inferred, not only where it is written.
    expectTypeOf(minimalGui).returns.toExtend<GuiPlugin>();
    expect(BILLING_SURFACE.views?.map((view) => view.examples.length)).toEqual([1, 1, 1]);
  });

  it("names the plugin gate's target kinds as its core entity kinds", () => {
    expectTypeOf<GateTarget["kind"]>().toEqualTypeOf<CoreEntityKind>();
  });

  it("records a version for every view kind, none newer than the contract", () => {
    expectTypeOf<keyof typeof GUI_KINDS_SINCE>().toEqualTypeOf<ViewKind>();
    expect(GUI_CONTRACT).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = versionParts(GUI_CONTRACT);
    for (const since of Object.values(GUI_KINDS_SINCE)) {
      expect(since).toMatch(/^\d+\.\d+\.\d+$/);
      const [a, b, c] = versionParts(since);
      expect(a * 1e6 + b * 1e3 + c).toBeLessThanOrEqual(major * 1e6 + minor * 1e3 + patch);
    }
  });
});
