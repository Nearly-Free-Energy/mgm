/**
 * The long-lived MGM root context (docs/cordis-runtime.md).
 *
 * One root per module instance — one per warm server process. It loads the
 * platform plugins: the catalog, the plugin gate, the GUI surface with the
 * compiled-in GUIs, and the provider registries with the providers that
 * register into them. Platform plugins hold no request data; requests run in
 * isolated children (`scope.ts`).
 */
import "server-only";

import { Context, type Fiber, type Plugin } from "cordis";
import {
  MGM_BUNDLED_PLUGINS,
  getBundledPlugin,
  type MgmPluginName,
} from "@/lib/plugins/bundled";
import { OpenEmsMeteringPlugin } from "@/lib/metering/providers-plugin";
import { GUI_META } from "@/gui/meta";
import type { GuiMeta } from "@/lib/gui/contract";
import { SurfaceRegistry } from "@/lib/gui/host/server/surface-registry";
import { PesapalProviderPlugin } from "@/lib/payments/providers/pesapal/plugin";
import { MgmGate } from "./gate";
import {
  MeteringProviderFactories,
  PaymentProviderRegistry,
  type MgmCatalog,
} from "./services";

export const CatalogPlugin = {
  name: "mgm-catalog",
  apply(ctx: Context) {
    const catalog: MgmCatalog = {
      plugins: MGM_BUNDLED_PLUGINS,
      get: (name) => getBundledPlugin(name),
      isCore: (name: MgmPluginName) => getBundledPlugin(name)?.core ?? false,
    };
    ctx.provide("mgmCatalog", catalog);
  },
} satisfies Plugin.Object<void>;

export const GatePlugin = {
  name: "mgm-gate",
  inject: ["mgmCatalog"],
  apply(ctx: Context) {
    ctx.provide("mgmGate", new MgmGate(ctx.mgmCatalog));
  },
} satisfies Plugin.Object<void>;

/**
 * The GUI surface: capability contributions and installed GUIs, checked when
 * they register. A root service, never a request one (docs/cordis-runtime.md
 * § "GUI surface").
 */
export const SurfacePlugin = {
  name: "mgm-surface",
  inject: ["mgmCatalog"],
  apply(ctx: Context) {
    ctx.provide("mgmSurface", new SurfaceRegistry(ctx.mgmCatalog));
  },
} satisfies Plugin.Object<void>;

/** Installs one compiled-in GUI's metadata. The Cordis plugin name is the GUI's name. */
export function guiInstallPlugin(name: string, meta: GuiMeta) {
  return {
    name,
    inject: ["mgmSurface"],
    apply(ctx: Context) {
      if (meta.name !== name) {
        throw new Error(`GUI "${name}" names itself "${meta.name}" in its metadata`);
      }
      // Installation is undone when this fiber unloads.
      ctx.effect(() => ctx.mgmSurface.install(meta));
    },
  } satisfies Plugin.Object<void>;
}

export const MeteringProvidersPlugin = {
  name: "metering-providers",
  apply(ctx: Context) {
    ctx.provide("meteringProviders", new MeteringProviderFactories());
  },
} satisfies Plugin.Object<void>;

export const PaymentProvidersPlugin = {
  name: "payment-providers",
  apply(ctx: Context) {
    ctx.provide("paymentProviderRegistry", new PaymentProviderRegistry());
  },
} satisfies Plugin.Object<void>;

/** Load order matters only for readability; Cordis resolves `inject`. */
export const PLATFORM_PLUGINS: readonly Plugin.Object<void>[] = [
  CatalogPlugin,
  GatePlugin,
  SurfacePlugin,
  ...Object.entries(GUI_META).map(([name, meta]) => guiInstallPlugin(name, meta)),
  MeteringProvidersPlugin,
  OpenEmsMeteringPlugin,
  PaymentProvidersPlugin,
  PesapalProviderPlugin,
];

export type MgmRuntime = {
  root: Context;
  catalog: MgmCatalog;
  gate: MgmGate;
  /** The registry itself, for the host's reads; plugins see `ctx.mgmSurface`, typed MgmSurface. */
  mgmSurface: SurfaceRegistry;
  meteringProviders: MeteringProviderFactories;
  paymentProviders: PaymentProviderRegistry;
  /** Platform plugin fibers, for diagnostics and tests. */
  fibers: readonly Fiber[];
};

/**
 * `FiberState.ACTIVE`. Cordis declares `FiberState` as an ambient const enum,
 * which `isolatedModules` cannot read — if Cordis renumbers it, revisit.
 * `runtime.test.ts` compares it with the value Cordis exports at runtime.
 */
export const FIBER_ACTIVE = 2;

/** Wait for a fiber and fail if it is not active (missing inject, error). */
export async function requireActive(fiber: Fiber, label: string): Promise<Fiber> {
  await fiber;
  if (fiber.state !== FIBER_ACTIVE) {
    throw new Error(`Cordis plugin "${label}" did not activate`);
  }
  return fiber;
}

/**
 * Loads `plugins` into `root` in order. If one fails, unloads those already
 * loaded, newest first, and rethrows its error. getMgmRuntime loads
 * PLATFORM_PLUGINS through it; tests pass their own lists.
 */
export async function loadPlatformPlugins(
  root: Context,
  plugins: readonly Plugin.Object<void>[]
): Promise<Fiber[]> {
  const fibers: Fiber[] = [];
  try {
    for (const plugin of plugins) {
      fibers.push(await requireActive(root.plugin(plugin), plugin.name ?? "anonymous"));
    }
  } catch (error) {
    await Promise.allSettled([...fibers].reverse().map((fiber) => fiber.dispose()));
    throw error;
  }
  return fibers;
}

async function createRuntime(): Promise<MgmRuntime> {
  const root = new Context();
  const fibers = await loadPlatformPlugins(root, PLATFORM_PLUGINS);
  return {
    root,
    catalog: root.get("mgmCatalog") as MgmCatalog,
    gate: root.get("mgmGate") as MgmGate,
    mgmSurface: root.get("mgmSurface") as SurfaceRegistry,
    meteringProviders: root.get("meteringProviders") as MeteringProviderFactories,
    paymentProviders: root.get("paymentProviderRegistry") as PaymentProviderRegistry,
    fibers,
  };
}

let runtime: Promise<MgmRuntime> | null = null;

export function getMgmRuntime(): Promise<MgmRuntime> {
  if (!runtime) {
    runtime = createRuntime().catch((error) => {
      // Do not cache a failed start; the next request retries.
      runtime = null;
      throw error;
    });
  }
  return runtime;
}

/** Tests only: dispose the root so the next call builds a fresh one. */
export async function resetMgmRuntimeForTests(): Promise<void> {
  const current = runtime;
  runtime = null;
  if (!current) return;
  try {
    const { fibers } = await current;
    for (const fiber of [...fibers].reverse()) await fiber.dispose();
  } catch {
    // A failed start has nothing to dispose.
  }
}
