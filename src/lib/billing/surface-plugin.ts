/**
 * Registers billing's GUI contribution (./surface.ts) on the root
 * surface (docs/cordis-runtime.md § "GUI surface").
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import "@/lib/runtime/services";
import { BILLING_SURFACE } from "./surface";

export const BillingSurfacePlugin = {
  name: "billing-surface",
  inject: ["mgmSurface"],
  apply(ctx: Context) {
    // The contribution is removed when this fiber unloads.
    ctx.effect(() => ctx.mgmSurface.contribute(BILLING_SURFACE));
  },
} satisfies Plugin.Object<void>;
