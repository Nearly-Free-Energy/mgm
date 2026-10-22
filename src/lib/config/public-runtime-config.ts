/**
 * Request-time public runtime configuration (#46, RFC #30 §3 "Container
 * runtime configuration mechanism").
 *
 * One built application (a Vercel build or the published container image)
 * must serve independent installations. The browser therefore never reads
 * Supabase settings from `process.env` in its bundle: the root layout reads
 * this allowlist on the server at request time and hands the three public
 * values to `PublicRuntimeConfigProvider`.
 *
 * The allowlist is exactly:
 *   MGM_PUBLIC_SUPABASE_URL          (required)
 *   MGM_PUBLIC_SUPABASE_ANON_KEY     (required, public anon/publishable key)
 *   MGM_PUBLIC_SUPABASE_COOKIE_NAME  (optional)
 *
 * The names deliberately avoid Next.js's `NEXT_PUBLIC_` prefix, which would
 * inline build-time values into the bundles.
 *
 * Legacy fallback (one release, documented in docs/setup.md): when neither
 * MGM_PUBLIC_SUPABASE_URL nor MGM_PUBLIC_SUPABASE_ANON_KEY is set, the
 * former NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / _COOKIE_NAME are read as a
 * set. The two sets are never mixed.
 *
 * This module is imported by server code and by the edge middleware only.
 * Do not import it from a "use client" module: the browser gets its values
 * from the provider, never from here. It carries no `server-only` import
 * because the middleware bundle imports it.
 *
 * Errors name the offending variable and never echo its value.
 */

/** The only values ever serialized to the browser. */
export type PublicRuntimeConfig = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** Undefined means "@supabase/ssr default cookie name". */
  cookieName?: string;
};

export type RuntimeEnv = Record<string, string | undefined>;

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

const MGM_NAMES = {
  url: "MGM_PUBLIC_SUPABASE_URL",
  anonKey: "MGM_PUBLIC_SUPABASE_ANON_KEY",
  cookieName: "MGM_PUBLIC_SUPABASE_COOKIE_NAME",
} as const;

const LEGACY_NAMES = {
  url: "NEXT_PUBLIC_SUPABASE_URL",
  anonKey: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  cookieName: "NEXT_PUBLIC_SUPABASE_COOKIE_NAME",
} as const;

const COOKIE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Validates an absolute http(s) URL with no credentials, query or fragment.
 * Returns it without a trailing slash.
 */
export function parseHttpUrl(value: string, variable: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeConfigError(`${variable} is not a valid absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeConfigError(`${variable} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new RuntimeConfigError(`${variable} must not contain credentials.`);
  }
  if (url.search || url.hash) {
    throw new RuntimeConfigError(
      `${variable} must not contain a query string or fragment.`
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Refuses keys that must never reach a browser: Supabase secret keys
 * (`sb_secret_…`) and legacy JWT keys whose role is `service_role`. A
 * misconfigured installation fails here instead of serializing a privileged
 * key into every HTML response.
 */
function assertPublicKey(value: string, variable: string): void {
  if (/\s/.test(value)) {
    throw new RuntimeConfigError(`${variable} must not contain whitespace.`);
  }
  if (value.startsWith("sb_secret_")) {
    throw new RuntimeConfigError(
      `${variable} holds a secret key; it must be the public anon (publishable) key.`
    );
  }
  const parts = value.split(".");
  if (parts.length === 3) {
    let role: unknown;
    try {
      // atob, not Buffer: this also runs in the edge middleware runtime.
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
      role = (JSON.parse(json) as { role?: unknown }).role;
    } catch {
      role = undefined;
    }
    if (role === "service_role") {
      throw new RuntimeConfigError(
        `${variable} holds a service-role key; it must be the public anon key.`
      );
    }
  }
}

export type ParsedPublicRuntimeConfig = {
  config: PublicRuntimeConfig;
  /** Which variable set supplied the values. Server-side only. */
  source: "mgm" | "legacy";
};

function selectNames(env: RuntimeEnv): { names: typeof MGM_NAMES | typeof LEGACY_NAMES; useMgm: boolean } {
  const hasMgm =
    present(env[MGM_NAMES.url]) !== undefined ||
    present(env[MGM_NAMES.anonKey]) !== undefined;
  const hasLegacy =
    present(env[LEGACY_NAMES.url]) !== undefined ||
    present(env[LEGACY_NAMES.anonKey]) !== undefined;
  // MGM names win whenever either is set; with nothing set, report the MGM
  // names as the ones to configure. The two sets are never mixed.
  const useMgm = hasMgm || !hasLegacy;
  return { names: useMgm ? MGM_NAMES : LEGACY_NAMES, useMgm };
}

/**
 * Pure parser over an environment record, for tests and for
 * `getPublicRuntimeConfig()`.
 */
export function parsePublicRuntimeConfig(env: RuntimeEnv): ParsedPublicRuntimeConfig {
  const { names, useMgm } = selectNames(env);

  const rawUrl = present(env[names.url]);
  const rawKey = present(env[names.anonKey]);
  const missing: string[] = [];
  if (!rawUrl) missing.push(names.url);
  if (!rawKey) missing.push(names.anonKey);
  if (missing.length > 0) {
    throw new RuntimeConfigError(
      `Missing required runtime configuration: ${missing.join(", ")}. ` +
        "See docs/setup.md, section \"Runtime configuration\"."
    );
  }

  const supabaseUrl = parseHttpUrl(rawUrl!, names.url);
  assertPublicKey(rawKey!, names.anonKey);

  const rawCookie = present(env[names.cookieName]);
  if (rawCookie !== undefined && !COOKIE_NAME_PATTERN.test(rawCookie)) {
    throw new RuntimeConfigError(
      `${names.cookieName} may contain only letters, digits, '.', '_' and '-' (at most 128).`
    );
  }

  return {
    config: {
      supabaseUrl,
      supabaseAnonKey: rawKey!,
      ...(rawCookie !== undefined ? { cookieName: rawCookie } : {}),
    },
    source: useMgm ? "mgm" : "legacy",
  };
}

/**
 * Reads the live environment. Each name is accessed literally so the edge
 * middleware bundler can see which variables it needs; the MGM_ names have
 * no NEXT_PUBLIC_ prefix and are therefore never inlined at build time.
 */
function readEnv(): RuntimeEnv {
  return {
    MGM_PUBLIC_SUPABASE_URL: process.env.MGM_PUBLIC_SUPABASE_URL,
    MGM_PUBLIC_SUPABASE_ANON_KEY: process.env.MGM_PUBLIC_SUPABASE_ANON_KEY,
    MGM_PUBLIC_SUPABASE_COOKIE_NAME: process.env.MGM_PUBLIC_SUPABASE_COOKIE_NAME,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SUPABASE_COOKIE_NAME: process.env.NEXT_PUBLIC_SUPABASE_COOKIE_NAME,
    SUPABASE_INTERNAL_URL: process.env.SUPABASE_INTERNAL_URL,
  };
}

let legacyWarned = false;

/**
 * The validated public configuration for this request. Read per call (no
 * module-level cache), so nothing computed for one environment outlives it.
 * Throws `RuntimeConfigError` on missing or invalid settings.
 */
export function getPublicRuntimeConfig(env: RuntimeEnv = readEnv()): PublicRuntimeConfig {
  const parsed = parsePublicRuntimeConfig(env);
  if (parsed.source === "legacy" && !legacyWarned) {
    legacyWarned = true;
    console.warn(
      "[mgm] NEXT_PUBLIC_SUPABASE_* configuration is deprecated; rename to " +
        "MGM_PUBLIC_SUPABASE_URL, MGM_PUBLIC_SUPABASE_ANON_KEY and " +
        "MGM_PUBLIC_SUPABASE_COOKIE_NAME (docs/setup.md)."
    );
  }
  return parsed.config;
}

/**
 * The Supabase URL server code connects to: the server-only
 * SUPABASE_INTERNAL_URL override when set (container networking), otherwise
 * the public URL. Never serialized.
 */
export function getServerSupabaseUrl(env: RuntimeEnv = readEnv()): string {
  const internal = present(env.SUPABASE_INTERNAL_URL);
  if (internal) return parseHttpUrl(internal, "SUPABASE_INTERNAL_URL");
  // Service-role callers need the URL only, not the anon key.
  const { names } = selectNames(env);
  const publicUrl = present(env[names.url]);
  if (!publicUrl) {
    throw new RuntimeConfigError(
      `Missing required runtime configuration: ${names.url}. ` +
        "See docs/setup.md, section \"Runtime configuration\"."
    );
  }
  return parseHttpUrl(publicUrl, names.url);
}

/**
 * Everything a server-side or middleware Supabase client needs, from one
 * validated read: the server connection URL (internal override applied),
 * the public anon key and the shared public config (for the cookie name).
 */
export function getServerSupabaseSettings(env: RuntimeEnv = readEnv()): {
  url: string;
  anonKey: string;
  publicConfig: PublicRuntimeConfig;
} {
  const publicConfig = getPublicRuntimeConfig(env);
  const internal = present(env.SUPABASE_INTERNAL_URL);
  return {
    url: internal ? parseHttpUrl(internal, "SUPABASE_INTERNAL_URL") : publicConfig.supabaseUrl,
    anonKey: publicConfig.supabaseAnonKey,
    publicConfig,
  };
}
