/**
 * Platform plugins that register metering sources into the root
 * `meteringProviders` registry (docs/cordis-runtime.md).
 *
 * A second metering source is one more plugin shaped like
 * `OpenEmsMeteringPlugin`; billing and the routes do not change.
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import "@/lib/runtime/services";
import { createOpenEmsMeteringProvider } from "./openems-provider";

export const OpenEmsMeteringPlugin = {
  name: "openems-metering",
  inject: ["meteringProviders"],
  apply(ctx: Context) {
    // Registration is undone when this fiber unloads.
    ctx.effect(() =>
      ctx.meteringProviders.register("openems", (supabase) =>
        createOpenEmsMeteringProvider(supabase),
        { fallback: true }
      )
    );
  },
} satisfies Plugin.Object<void>;
