/**
 * Registers the organization directory's GUI contribution (./surface.ts) on the root
 * surface (docs/cordis-runtime.md § "GUI surface").
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import "@/lib/runtime/services";
import { ORGANIZATION_DIRECTORY_SURFACE } from "./surface";

export const OrganizationDirectorySurfacePlugin = {
  name: "organization-directory-surface",
  inject: ["mgmSurface"],
  apply(ctx: Context) {
    // The contribution is removed when this fiber unloads.
    ctx.effect(() => ctx.mgmSurface.contribute(ORGANIZATION_DIRECTORY_SURFACE));
  },
} satisfies Plugin.Object<void>;
