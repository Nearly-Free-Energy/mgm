/**
 * Registers community management's GUI contribution (./surface.ts) on the root
 * surface (docs/cordis-runtime.md § "GUI surface").
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import "@/lib/runtime/services";
import { COMMUNITY_MANAGEMENT_SURFACE } from "./surface";

export const CommunityManagementSurfacePlugin = {
  name: "community-management-surface",
  inject: ["mgmSurface"],
  apply(ctx: Context) {
    // The contribution is removed when this fiber unloads.
    ctx.effect(() => ctx.mgmSurface.contribute(COMMUNITY_MANAGEMENT_SURFACE));
  },
} satisfies Plugin.Object<void>;
