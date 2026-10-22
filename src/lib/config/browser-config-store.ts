/**
 * Holds the public runtime configuration that `PublicRuntimeConfigProvider`
 * received from the server, for browser Supabase client factories that are
 * called outside React context (event handlers, module helpers).
 *
 * The values are the same three public fields every HTML response already
 * carries; nothing privileged is ever stored here. Reads throw clearly when
 * the provider has not rendered yet instead of falling back to a value baked
 * into the bundle.
 */
import type { PublicRuntimeConfig } from "./public-runtime-config";

let current: PublicRuntimeConfig | null = null;

export function setBrowserPublicRuntimeConfig(config: PublicRuntimeConfig): void {
  current = config;
}

export function getBrowserPublicRuntimeConfig(): PublicRuntimeConfig {
  if (!current) {
    throw new Error(
      "Public runtime configuration is not available yet. Supabase browser " +
        "clients must be created inside the tree rendered by the root layout."
    );
  }
  return current;
}

/** Test helper. */
export function resetBrowserPublicRuntimeConfig(): void {
  current = null;
}
