import "server-only";

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
 * inline build-time values into the bundles. The former NEXT_PUBLIC_SUPABASE_*
 * names are no longer read (#79); retired-names.ts only warns about them at
 * server start.
 *
 * Server-only: the server, the middleware (Node.js runtime) and
 * instrumentation import it, and Next.js builds all three as server code, so
 * `server-only` fails `next build` only for a client import. Browser code
 * imports its type alone and gets the values from the provider.
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

const NAMES = {
  url: "MGM_PUBLIC_SUPABASE_URL",
  anonKey: "MGM_PUBLIC_SUPABASE_ANON_KEY",
  cookieName: "MGM_PUBLIC_SUPABASE_COOKIE_NAME",
} as const;

const COOKIE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function missingConfiguration(names: string[]): RuntimeConfigError {
  return new RuntimeConfigError(
    `Missing required runtime configuration: ${names.join(", ")}. ` +
      "See docs/setup.md, section \"Runtime configuration\"."
  );
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
 * Accepts only keys that are meant for browsers: Supabase publishable keys
 * (`sb_publishable_…`) and legacy JWT keys whose `role` claim is `anon`.
 * Everything else (secret keys, service-role JWTs, malformed values) is
 * refused, so a misconfigured installation fails here instead of
 * serializing a privileged key into every HTML response.
 */
function assertPublicKey(value: string, variable: string): void {
  const refuse = (): never => {
    throw new RuntimeConfigError(
      `${variable} must be the public key: an sb_publishable_ key or an anon-role JWT.`
    );
  };
  if (/\s/.test(value)) {
    throw new RuntimeConfigError(`${variable} must not contain whitespace.`);
  }
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return;
  const parts = value.split(".");
  if (parts.length !== 3) refuse();
  let role: unknown;
  try {
    // atob, not Buffer: keeps the module runtime-neutral.
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    role = (JSON.parse(json) as { role?: unknown }).role;
  } catch {
    role = undefined;
  }
  if (role !== "anon") refuse();
}

/**
 * Pure parser over an environment record, for tests and for
 * `getPublicRuntimeConfig()`.
 */
export function parsePublicRuntimeConfig(env: RuntimeEnv): PublicRuntimeConfig {
  const rawUrl = present(env[NAMES.url]);
  const rawKey = present(env[NAMES.anonKey]);
  const missing: string[] = [];
  if (!rawUrl) missing.push(NAMES.url);
  if (!rawKey) missing.push(NAMES.anonKey);
  if (missing.length > 0) throw missingConfiguration(missing);

  const supabaseUrl = parseHttpUrl(rawUrl!, NAMES.url);
  assertPublicKey(rawKey!, NAMES.anonKey);

  const rawCookie = present(env[NAMES.cookieName]);
  if (rawCookie !== undefined && !COOKIE_NAME_PATTERN.test(rawCookie)) {
    throw new RuntimeConfigError(
      `${NAMES.cookieName} may contain only letters, digits, '.', '_' and '-' (at most 128).`
    );
  }

  return {
    supabaseUrl,
    supabaseAnonKey: rawKey!,
    ...(rawCookie !== undefined ? { cookieName: rawCookie } : {}),
  };
}

/**
 * Reads the live environment. The MGM_ names have no NEXT_PUBLIC_ prefix and
 * are therefore never inlined at build time; the middleware runs on the
 * Node.js runtime (src/middleware.ts), so it reads the real process
 * environment like the rest of the server.
 */
function readEnv(): RuntimeEnv {
  return {
    MGM_PUBLIC_SUPABASE_URL: process.env.MGM_PUBLIC_SUPABASE_URL,
    MGM_PUBLIC_SUPABASE_ANON_KEY: process.env.MGM_PUBLIC_SUPABASE_ANON_KEY,
    MGM_PUBLIC_SUPABASE_COOKIE_NAME: process.env.MGM_PUBLIC_SUPABASE_COOKIE_NAME,
    SUPABASE_INTERNAL_URL: process.env.SUPABASE_INTERNAL_URL,
  };
}

/**
 * Validates the whole server-side configuration once at server start
 * (src/instrumentation.ts). Same checks as request time.
 */
export function validatePublicRuntimeConfigAtStartup(env: RuntimeEnv = readEnv()): void {
  getServerSupabaseSettings(env);
}

/**
 * The validated public configuration for this request. Read per call (no
 * module-level cache), so nothing computed for one environment outlives it.
 * Throws `RuntimeConfigError` on missing or invalid settings.
 */
export function getPublicRuntimeConfig(env: RuntimeEnv = readEnv()): PublicRuntimeConfig {
  return parsePublicRuntimeConfig(env);
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
  const publicUrl = present(env[NAMES.url]);
  if (!publicUrl) throw missingConfiguration([NAMES.url]);
  return parseHttpUrl(publicUrl, NAMES.url);
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
  const rawInternal = present(env.SUPABASE_INTERNAL_URL);
  const internal = rawInternal ? parseHttpUrl(rawInternal, "SUPABASE_INTERNAL_URL") : undefined;
  // @supabase/ssr derives its default cookie name from the URL it is given.
  // The server and middleware connect to the internal URL while the browser
  // uses the public one, so without an explicit name the two sides would
  // look for different cookies and sessions would never stick. supabase-js
  // keys the default on the first hostname label only; comparing the full
  // host is deliberately stricter and only refuses configs that would have
  // worked. If that derivation changes, revisit this check.
  if (
    internal &&
    !publicConfig.cookieName &&
    new URL(internal).host !== new URL(publicConfig.supabaseUrl).host
  ) {
    throw new RuntimeConfigError(
      `SUPABASE_INTERNAL_URL points at a different host than ${NAMES.url}, ` +
        `so ${NAMES.cookieName} must be set (e.g. sb-mgm-auth-token).`
    );
  }
  return {
    url: internal ?? publicConfig.supabaseUrl,
    anonKey: publicConfig.supabaseAnonKey,
    publicConfig,
  };
}
