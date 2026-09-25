/** The only web and API routes shipped by MGM Release 1. Keep this list explicit. */
const PAGE_ROUTES = [
  /^\/$/,
  /^\/(?:login|accept-invite|forgot-password|reset-password|no-access|setup)$/,
  /^\/organizations(?:\/[^/]+)?$/,
  /^\/communities(?:\/[^/]+)?$/,
  /^\/microgrids(?:\/[^/]+)?$/,
  /^\/microgrids\/[^/]+\/setup\/households$/,
  /^\/settings\/(?:profile|plugins|users)$/,
];

const API_ROUTES = [
  /^\/api\/mgm\/bootstrap$/,
  /^\/api\/mgm\/health$/,
  /^\/api\/organizations(?:\/[^/]+(?:\/(?:plugins|delete-preview))?)?$/,
  /^\/api\/communities(?:\/[^/]+(?:\/delete-preview)?)?$/,
  /^\/api\/microgrids(?:\/[^/]+(?:\/delete-preview)?)?$/,
  /^\/api\/households\/(?:with-meter|[^/]+)$/,
  /^\/api\/users(?:\/invite|\/[^/]+(?:\/(?:profile|role|resend-invite))?)?$/,
];

export function isRelease1Route(pathname: string): boolean {
  const path = pathname.replace(/\/$/, "") || "/";
  return [...PAGE_ROUTES, ...API_ROUTES].some((pattern) => pattern.test(path));
}
