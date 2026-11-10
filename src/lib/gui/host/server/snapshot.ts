import "server-only";

/**
 * The one place host code reads the GUI surface registry. Every other host
 * module takes the snapshot as an argument or imports this, so the
 * session-check test (service-role-session-check.test.ts) follows each
 * caller by import: callers settle the session first, because the loaders,
 * signals and search the registry holds can compose credentialed
 * capabilities.
 */
import { getMgmRuntime } from "@/lib/runtime/root";
import type { SurfaceSnapshot } from "./surface-registry";

export async function surfaceSnapshot(): Promise<SurfaceSnapshot> {
  return (await getMgmRuntime()).mgmSurface.snapshot();
}
