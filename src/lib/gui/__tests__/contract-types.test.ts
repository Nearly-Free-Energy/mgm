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
import type { Context } from "cordis";
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
  Fmt,
  LoadedModel,
  MgmSurface,
  NavDef,
  Prepare,
  ProposableAction,
  SignalDef,
  TenantRequest,
  ViewDef,
} from "../surface";
import type { GateTarget } from "@/lib/runtime/gate";
import type {} from "@/lib/runtime/services";
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

  it("gives a tenant view's loader its unit, and refuses segments, attachments and assistant reading on it", () => {
    const tenantView = {
      id: "tenant.home",
      kind: "record",
      scope: "tenant",
      path: "/my",
      params: {},
      cost: "db",
      declares: { keys: [] },
      examples: [],
      load: async (req: TenantRequest) => {
        expectTypeOf(req.tenantId).toEqualTypeOf<string>();
        expectTypeOf(req.organizationId).toEqualTypeOf<null>();
        return { ok: true as const, model: recordModel };
      },
    } as const;
    accept<ViewDef>(tenantView);
    // @ts-expect-error a tenant view's unit is the caller's, never a path segment
    accept<ViewDef>({ ...tenantView, path: "/my/[id]", params: { id: "tenant" } });
    // @ts-expect-error a tenant view is never attached to another view
    accept<ViewDef>({ ...tenantView, attach: { to: "tenant", order: 1, hint: "tab" } });
    // @ts-expect-error a tenant view is never read by an assistant
    accept<ViewDef>({ ...tenantView, agent: "read" });
    // @ts-expect-error an organization view's loader gets an organization, not a unit
    accept<ViewDef>({ ...tenantView, scope: "organization" });
  });

  it("names what an action and an attachment keep while their plugin is off, each its own word", () => {
    accept<ActionDef>({ ...base, method: "POST", risk: "write", humanOnly: true, confirm: "none", whilePluginOff: "enabled" });
    // @ts-expect-error an action is kept "enabled", not a flag
    accept<ActionDef>({ ...base, method: "POST", risk: "write", humanOnly: true, confirm: "none", whilePluginOff: true });
    // @ts-expect-error "listed" is an attachment's word, not an action's
    accept<ActionDef>({ ...base, method: "POST", risk: "write", humanOnly: true, confirm: "none", whilePluginOff: "listed" });
    const view = {
      id: "payments.x",
      kind: "collection",
      path: "/microgrids/[id]/billing",
      params: { id: "microgrid" },
      cost: "db",
      declares: { keys: [] },
      examples: [],
      load: async () => ({ ok: false as const, status: 503 as const, message: "fixture" }),
    } as const;
    accept<ViewDef>({ ...view, attach: { to: "microgrid", order: 1, hint: "tab", whilePluginOff: "listed" } });
    // @ts-expect-error "enabled" is an action's word, not an attachment's
    accept<ViewDef>({ ...view, attach: { to: "microgrid", order: 1, hint: "tab", whilePluginOff: "enabled" } });
  });

  it("asks a watcher for examples, which carry no source", () => {
    const example = { id: "p1", kind: "your-move", severity: "warn", title: "October 2026 is not closed", href: "/microgrids", at: "2026-11-01T00:00:00Z" } as const;
    accept<SignalDef>({ id: "billing.x", load: async () => [], examples: [example] });
    // @ts-expect-error a watcher declares examples
    accept<SignalDef>({ id: "billing.x", load: async () => [] });
    // @ts-expect-error the host sets a signal's source
    accept<SignalDef>({ id: "billing.x", load: async () => [], examples: [{ ...example, source: "billing.x" }] });
  });

  it("names the nav audiences", () => {
    expectTypeOf<NonNullable<NavDef["audience"]>>().toEqualTypeOf<"staff" | "super-admin" | "tenant">();
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

  it("refuses a status map that STATUS_MAPS does not name", () => {
    const unknownMap = (fmt: Fmt) =>
      // @ts-expect-error fmt.status takes a map from STATUS_MAPS
      fmt.status("nope", "x");
    expect(unknownMap).toBeTypeOf("function");
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

  it("gives plugins the surface's write side only", () => {
    expectTypeOf<Context["mgmSurface"]>().toEqualTypeOf<MgmSurface>();
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
