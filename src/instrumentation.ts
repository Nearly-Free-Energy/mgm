/**
 * Server-start validation of runtime configuration (#46).
 *
 * Next.js calls register() once when a server instance starts. It is skipped
 * during `next build` (NEXT_PHASE), because a build carries no installation
 * settings by design, and on the Edge runtime. It first warns about any
 * variable name retired after v0.0.2 that is still set without its
 * replacement (#79), naming both and never the value. An invalid Supabase
 * setting rejects register(): Next.js logs "Failed to prepare server", the
 * process keeps running and every request fails with 500. An invalid
 * MGM_APP_URL is logged here (variable named, never its value) and does not
 * throw, because only payments need it and they fail closed through
 * appUrl(). An MGM_GUI that names no compiled-in GUI is logged the same way
 * and does not throw: no page reads it yet, and the interface pages that will
 * (through readGuiName()) answer 500 for the same error, while payment pages
 * and webhooks, which render no interface, keep working (decision 3 on #115).
 * If a payment page or webhook starts reading MGM_GUI, revisit. A compiled-in
 * GUI whose contract range excludes this build is different: the runtime root
 * refuses to install it, which stops every request that opens a scope.
 * Do not call process.exit() here; it would break Vercel.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { warnAboutRetiredNames } = await import("@/lib/config/retired-names");
  const { validateAppUrlAtStartup } = await import("@/lib/config/app-url");
  const { validateGuiAtStartup } = await import("@/lib/config/gui");
  const { validatePublicRuntimeConfigAtStartup } = await import(
    "@/lib/config/public-runtime-config"
  );
  warnAboutRetiredNames();
  try {
    validateAppUrlAtStartup();
  } catch (error) {
    console.error(
      `[mgm] Invalid application URL; payment features will fail until it is fixed. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  try {
    validateGuiAtStartup();
  } catch (error) {
    console.error(
      `[mgm] Invalid interface setting (MGM_GUI). ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  validatePublicRuntimeConfigAtStartup();
}
