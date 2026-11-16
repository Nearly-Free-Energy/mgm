/**
 * SMTP transport plugin: registers the `smtp` factory into the root
 * `mailTransports` registry (docs/cordis-runtime.md). An API-based sender is
 * one more plugin shaped like this one.
 */
import "server-only";

import type { Context, Plugin } from "cordis";
import "@/lib/runtime/services";
import { createSmtpTransport } from "./transport";

export const SMTP_TRANSPORT = "smtp";

export const SmtpTransportPlugin = {
  name: "smtp",
  inject: ["mailTransports"],
  apply(ctx: Context) {
    // Registration is undone when this fiber unloads.
    ctx.effect(() => ctx.mailTransports.register(SMTP_TRANSPORT, (settings) => createSmtpTransport(settings)));
  },
} satisfies Plugin.Object<void>;
