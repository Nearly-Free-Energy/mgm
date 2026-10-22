import "server-only";

/**
 * Server-only public origin of this installation (#46, RFC #30 §3).
 *
 * `MGM_APP_URL` is the application's public origin, for example
 * `https://mgm.example.org`. Payments use it to build payment links and the
 * provider return URL, and to register the provider's payment notification
 * (IPN) URL. It is never sent to the browser.
 *
 * Legacy fallback for one release (docs/setup.md): when MGM_APP_URL is
 * unset, NEXT_PUBLIC_APP_URL and then the origin of
 * NEXT_PUBLIC_PAYMENT_CALLBACK_URL are used, as before.
 *
 * Read per call, so one process never reuses another environment's value,
 * and errors name the variable without echoing it.
 */
import {
  RuntimeConfigError,
  type RuntimeEnv,
} from "./public-runtime-config";

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseOrigin(
  value: string,
  variable: string,
  originOnly: boolean,
  requireHttps = false
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimeConfigError(`${variable} is not a valid absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeConfigError(`${variable} must use http or https.`);
  }
  if (requireHttps && url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new RuntimeConfigError(
      `${variable} must use https (http is allowed only for localhost/127.0.0.1).`
    );
  }
  if (url.username || url.password) {
    throw new RuntimeConfigError(`${variable} must not contain credentials.`);
  }
  if (originOnly && (url.pathname !== "/" || url.search || url.hash)) {
    throw new RuntimeConfigError(
      `${variable} must be an origin only (scheme, host and optional port, no path).`
    );
  }
  return url.origin;
}

/** Pure parser: the validated application origin, without a trailing slash. */
export function parseAppOrigin(env: RuntimeEnv): string {
  const mgm = present(env.MGM_APP_URL);
  if (mgm) return parseOrigin(mgm, "MGM_APP_URL", true, true);
  // Legacy names: previous releases accepted a path on both and used only
  // the origin, so keep that leniency for the fallback.
  const legacyApp = present(env.NEXT_PUBLIC_APP_URL);
  if (legacyApp) return parseOrigin(legacyApp, "NEXT_PUBLIC_APP_URL", false);
  const legacyCallback = present(env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL);
  if (legacyCallback) {
    return parseOrigin(legacyCallback, "NEXT_PUBLIC_PAYMENT_CALLBACK_URL", false);
  }
  throw new RuntimeConfigError(
    "Missing required runtime configuration: MGM_APP_URL. " +
      "See docs/setup.md, section \"Runtime configuration\"."
  );
}

function readEnv(): RuntimeEnv {
  return {
    MGM_APP_URL: process.env.MGM_APP_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_PAYMENT_CALLBACK_URL: process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL,
  };
}

/** The validated application origin for this request. */
export function getAppOrigin(env: RuntimeEnv = readEnv()): string {
  return parseAppOrigin(env);
}

/**
 * Absolute URL for an application path, e.g.
 * `appUrl("/api/payments/ipn")`. The path must start with a single "/".
 */
export function appUrl(path: string, env: RuntimeEnv = readEnv()): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Application paths must start with a single '/'.");
  }
  return `${parseAppOrigin(env)}${path}`;
}

/**
 * The payment provider's return URL (`/payment/callback`).
 *
 * With MGM_APP_URL: `${MGM_APP_URL}/payment/callback`.
 * Legacy mode (MGM_APP_URL unset), unchanged from previous releases: the
 * full NEXT_PUBLIC_PAYMENT_CALLBACK_URL, path included, when set; otherwise
 * the NEXT_PUBLIC_APP_URL origin plus `/payment/callback`.
 */
export function paymentReturnUrl(env: RuntimeEnv = readEnv()): string {
  if (present(env.MGM_APP_URL)) return appUrl("/payment/callback", env);
  const legacyCallback = present(env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL);
  if (legacyCallback) {
    parseOrigin(legacyCallback, "NEXT_PUBLIC_PAYMENT_CALLBACK_URL", false);
    return legacyCallback;
  }
  return appUrl("/payment/callback", env);
}

/**
 * Server-start check (src/instrumentation.ts). An invalid application URL
 * stops the server; a missing one is reported, because only the payments
 * plugin needs it and it fails clearly on first use.
 */
export function validateAppUrlAtStartup(env: RuntimeEnv = readEnv()): void {
  if (
    !present(env.MGM_APP_URL) &&
    !present(env.NEXT_PUBLIC_APP_URL) &&
    !present(env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL)
  ) {
    console.warn(
      "[mgm] MGM_APP_URL is not set; payment links and payment notification registration will fail until it is."
    );
    return;
  }
  parseAppOrigin(env);
}
