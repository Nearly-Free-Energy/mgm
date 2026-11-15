/**
 * The content security policy for the pages middleware lets through: where
 * a page may load scripts, styles, images, fonts and connections from. The
 * public payment pages are left out: their route handlers set a stricter
 * policy of their own (src/middleware.ts, ownPolicy).
 *
 * It is enforced (decision 19 on #115): browsers block what it does not
 * allow. It shipped report-only first, and was switched once the browser
 * smoke covered the invoice logo and the invoice PDF preview and failed on
 * any violation (e2e/invoice.spec.ts, e2e/checks.ts). That smoke runs a
 * headless Chromium with no PDF viewer; the preview's popup, a blob:
 * document that inherits this policy, object-src 'none' included, was
 * checked by hand to display in desktop Chrome 157, headed and headless,
 * against a production build sending the enforced header. If the preview
 * stops opening as a blob: document in a popup
 * (src/app/(gui)/communities/[id]/invoice/invoice-shell.tsx), check again.
 * "report-only" stays available for a policy change that needs a trial.
 *
 * Next.js reads the nonce from the forwarded request's
 * `content-security-policy` header (or the report-only one) and adds it to
 * the scripts it renders (checked in Next 16.4, `parse-request-headers`).
 * Every page is rendered per request (none is prerendered), so each gets
 * the nonce; a prerendered page would carry none, and its scripts would be
 * blocked. If Next.js stops reading the header, or a page becomes static,
 * scripts stop running; revisit then.
 */

export type CspMode = "report-only" | "enforce";

export const CSP_MODE: CspMode = "enforce";

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
