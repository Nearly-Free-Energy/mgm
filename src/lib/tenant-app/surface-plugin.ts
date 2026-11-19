/**
 * Registers the tenant app's GUI contribution (./surface.ts) on the root
 * surface (docs/cordis-runtime.md § "GUI surface").
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import "@/lib/runtime/services";
import { TENANT_APP_SURFACE } from "./surface";

export const TenantAppSurfacePlugin = {
  name: "tenant-app-surface",
  inject: ["mgmSurface"],
  apply(ctx: Context) {
    // The contribution is removed when this fiber unloads.
    ctx.effect(() => ctx.mgmSurface.contribute(TENANT_APP_SURFACE));
  },
} satisfies Plugin.Object<void>;
