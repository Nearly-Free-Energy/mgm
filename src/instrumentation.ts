/**
 * Server-start validation of runtime configuration (#46).
 *
 * Next.js calls register() once when a server instance starts. It is skipped
 * during `next build` (NEXT_PHASE), because a build carries no installation
 * settings by design, and on the Edge runtime. An invalid MGM_APP_URL or
 * Supabase setting stops the server with an error naming the variable, never
 * its value.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { validateAppUrlAtStartup } = await import("@/lib/config/app-url");
  const { validatePublicRuntimeConfigAtStartup } = await import(
    "@/lib/config/public-runtime-config"
  );
  validateAppUrlAtStartup();
  validatePublicRuntimeConfigAtStartup();
}
