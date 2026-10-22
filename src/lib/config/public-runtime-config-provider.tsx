"use client";

/**
 * Browser side of the request-time public configuration (#46).
 *
 * The root layout (a server component rendered per request) passes the
 * validated `PublicRuntimeConfig` here as props. The provider records it in
 * `browser-config-store` during render, before any child renders, so
 * `createClient()` in `@/lib/supabase/client` and the recovery client have
 * their values before they initialize. Nothing here reads `process.env`.
 *
 * Only the three public values may pass through this boundary. The props
 * type is the allowlist; adding a field here is adding something to every
 * HTML response.
 */
import * as React from "react";
import type { PublicRuntimeConfig } from "./public-runtime-config";
import { setBrowserPublicRuntimeConfig } from "./browser-config-store";

const PublicRuntimeConfigContext = React.createContext<PublicRuntimeConfig | null>(null);

export function PublicRuntimeConfigProvider({
  config,
  children,
}: {
  config: PublicRuntimeConfig;
  children: React.ReactNode;
}) {
  // Re-pick the allowlisted fields so an accidental wider object cannot
  // reach the context.
  const value = React.useMemo<PublicRuntimeConfig>(
    () => ({
      supabaseUrl: config.supabaseUrl,
      supabaseAnonKey: config.supabaseAnonKey,
      ...(config.cookieName ? { cookieName: config.cookieName } : {}),
    }),
    [config.supabaseUrl, config.supabaseAnonKey, config.cookieName]
  );
  // Idempotent: every render of one deployment writes the same values.
  setBrowserPublicRuntimeConfig(value);
  return (
    <PublicRuntimeConfigContext.Provider value={value}>
      {children}
    </PublicRuntimeConfigContext.Provider>
  );
}

/** The public configuration for components that prefer context. */
export function usePublicRuntimeConfig(): PublicRuntimeConfig {
  const value = React.useContext(PublicRuntimeConfigContext);
  if (!value) {
    throw new Error(
      "usePublicRuntimeConfig must be used inside PublicRuntimeConfigProvider (rendered by the root layout)."
    );
  }
  return value;
}
