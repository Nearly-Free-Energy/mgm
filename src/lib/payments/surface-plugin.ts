/**
 * Registers the payments capability's GUI contribution (./surface.ts) on
 * the root surface (docs/cordis-runtime.md § "GUI surface").
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import "@/lib/runtime/services";
import { PAYMENTS_SURFACE } from "./surface";

export const PaymentsSurfacePlugin = {
  name: "payments-surface",
  inject: ["mgmSurface"],
  apply(ctx: Context) {
    // The contribution is removed when this fiber unloads.
    ctx.effect(() => ctx.mgmSurface.contribute(PAYMENTS_SURFACE));
  },
} satisfies Plugin.Object<void>;
