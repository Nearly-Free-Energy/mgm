/**
 * The content security policy for the pages middleware lets through: where
 * a page may load scripts, styles, images, fonts and connections from.
 *
 * It ships report-only (decision 19 on #115): browsers report what it
 * would block and block nothing. Switching CSP_MODE to "enforce" is a
 * separate change, made once a browser check covers the invoice logo and
 * the invoice PDF preview.
 *
 * Next.js reads the nonce from the forwarded request's
 * `content-security-policy` or `content-security-policy-report-only`
 * header and adds it to the scripts it renders (checked in Next 16.4,
 * `parse-request-headers`). If it stops reading the report-only header,
 * the nonce is lost while in report-only mode; revisit then.
 */

export type CspMode = "report-only" | "enforce";

export const CSP_MODE: CspMode = "report-only";

export type CspHeaderName =
  | "content-security-policy"
  | "content-security-policy-report-only";

export function cspHeaderName(mode: CspMode = CSP_MODE): CspHeaderName {
  return mode === "enforce"
    ? "content-security-policy"
    : "content-security-policy-report-only";
}

/** 16 random bytes, base64: a fresh value for every request. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export type ContentSecurityPolicyOptions = {
  nonce: string;
  /** The Supabase URL browsers use; only its origin goes in the policy. */
  supabaseUrl: string;
  /** Development adds what hot reloading needs: eval and websockets. */
  development: boolean;
};

export function buildContentSecurityPolicy({
  nonce,
  supabaseUrl,
  development,
}: ContentSecurityPolicyOptions): string {
  const supabase = new URL(supabaseUrl).origin;
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(development ? ["'unsafe-eval'"] : []),
    ],
    // React and Radix set style attributes; if no component sets inline
    // styles any more, revisit 'unsafe-inline'.
    ["style-src", "'self'", "'unsafe-inline'"],
    // The invoice page shows the logo through a signed Supabase Storage
    // URL; if it stops doing so, revisit the Supabase origin here.
    ["img-src", "'self'", "data:", "blob:", supabase],
    ["font-src", "'self'"],
    // Browser code calls Supabase directly through @/lib/supabase/client
    // (sign-in, sign-out, password recovery, invite acceptance, some billing
    // reads and deletes); if no client component uses it any more, revisit.
    ["connect-src", "'self'", supabase, ...(development ? ["ws:"] : [])],
    ["form-action", "'self'"],
    ["base-uri", "'self'"],
    ["object-src", "'none'"],
    ["frame-ancestors", "'none'"],
    ["manifest-src", "'self'"],
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}
