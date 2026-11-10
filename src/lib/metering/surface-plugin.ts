/**
 * Registers metering's GUI contribution (./surface.ts) on the root
 * surface (docs/cordis-runtime.md § "GUI surface").
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import "@/lib/runtime/services";
import { METERING_SURFACE } from "./surface";

export const MeteringSurfacePlugin = {
  name: "metering-surface",
  inject: ["mgmSurface"],
  apply(ctx: Context) {
    // The contribution is removed when this fiber unloads.
    ctx.effect(() => ctx.mgmSurface.contribute(METERING_SURFACE));
  },
} satisfies Plugin.Object<void>;
