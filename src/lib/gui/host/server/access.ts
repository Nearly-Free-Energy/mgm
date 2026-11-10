import "server-only";

/**
 * Who a GUI host request is for, and the request objects contributed
 * loaders, signals, search and prepare functions receive.
 *
 * A HostContext exists only after the caller's session has been checked with
 * getUser() on this request. Every SurfaceRequest and InstallationRequest gets
 * a new client from the route's factory, bound to the caller's own session
 * (row-level security): never the client the route checked the session on,
 * and never the service role. supabase-js holds a client's auth lock for the
 * whole getUser() call, and composers call getUser() again, so separate
 * clients let those calls run side by side; if supabase-js stops queueing
 * queries behind getUser(), one client would do.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { rolesCanAccessOrg, type CurrentUserAccess } from "@/lib/auth/access";
import { detectLocale } from "@/lib/locale";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { Fmt, InstallationRequest, SurfaceRequest } from "../../surface";

/**
 * Returns a new row-level-security client for this request's session. Every
 * hostContext call in the host and its routes passes createClient from
 * @/lib/supabase/server, which no-cache.test.ts checks.
 */
export type ClientFactory = () => Promise<SupabaseClient>;

export type HostAccess = Readonly<{ user: User; roles: readonly UserRoleRecord[] }>;

export type HostContext = Readonly<{
  access: HostAccess;
  newClient: ClientFactory;
  locale: string;
  now: Date;
  fmt: Fmt;
}>;

export type HostRefusal = {
  ok: false;
  status: 401 | 403;
  code: "gui_unauthenticated" | "gui_no_access";
  message: string;
};

/**
 * Marks a context hostContext made. The mark is a non-enumerable property, so
 * a spread copy of a context does not carry it, and the host refuses the copy.
 */
const ISSUED = Symbol("gui.hostContext");

/** The request's locale from Accept-Language, or "en" when the tag is not one Intl accepts. */
function localeOf(headers: Headers): string {
  const tag = detectLocale(headers.get("accept-language"));
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? "en";
  } catch {
    return "en";
  }
}

/**
 * The host's context for one request.
 *
 * `access` must be what getCurrentUserAccess (@/lib/auth/access) or
 * getRequestUserAccess (@/lib/auth/request-access) returned on this request:
 * both ask Supabase Auth with getUser(). If either stops calling getUser(),
 * revisit. No user is a 401 and no role row a 403, before anything is loaded.
 */
export function hostContext(
  access: CurrentUserAccess,
  headers: Headers,
  deps: { newClient: ClientFactory; makeFmt: (locale: string) => Fmt; now?: Date },
): { ok: true; ctx: HostContext } | HostRefusal {
  if (!access.user) {
    return { ok: false, status: 401, code: "gui_unauthenticated", message: "Sign in to continue." };
  }
  if (access.roles.length === 0) {
    return { ok: false, status: 403, code: "gui_no_access", message: "Your account has no access yet." };
  }
  const locale = localeOf(headers);
  const ctx: HostContext = {
    access: Object.freeze({ user: access.user, roles: Object.freeze([...access.roles]) }),
    newClient: deps.newClient,
    locale,
    now: deps.now ?? new Date(),
    fmt: deps.makeFmt(locale),
  };
  Object.defineProperty(ctx, ISSUED, { value: true, enumerable: false });
  return { ok: true, ctx: Object.freeze(ctx) };
}

/** Throws unless hostContext made `ctx`. Every host entry point that opens a client calls it. */
export function requireIssued(ctx: HostContext): void {
  if (!Object.isFrozen(ctx) || !Object.hasOwn(ctx, ISSUED)) {
    throw new Error("GUI host: request built from a context hostContext did not issue");
  }
}

/** A copy of `search` without ui.* parameters, which belong to the GUI and never reach a loader. */
function withoutUiParams(search: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of search) if (!key.startsWith("ui.")) out.append(key, value);
  return out;
}

async function baseRequest(ctx: HostContext, params: Record<string, string>, search: URLSearchParams) {
  requireIssued(ctx);
  return {
    supabase: await ctx.newClient(),
    user: ctx.access.user,
    roles: [...ctx.access.roles],
    params: { ...params },
    search: withoutUiParams(search),
    locale: ctx.locale,
    now: ctx.now,
    fmt: ctx.fmt,
  };
}

/**
 * A request for one organization-scoped call, on a new client. Throws when
 * the caller's roles do not reach `organizationId`. resolveSegments
 * (entities.ts) refuses such an organization first, so this only fails on a
 * host bug; if the host stops resolving before it builds requests, this
 * throw is what refuses.
 */
export async function surfaceRequest(
  ctx: HostContext,
  organizationId: string,
  params: Record<string, string>,
  search: URLSearchParams,
): Promise<SurfaceRequest> {
  requireIssued(ctx);
  if (!rolesCanAccessOrg([...ctx.access.roles], organizationId)) {
    throw new Error("GUI host: surface request for an organization the caller cannot access");
  }
  return { ...(await baseRequest(ctx, params, search)), organizationId };
}

/** A request for an installation-wide call or a plugin's organizationOf, on a new client. */
export async function installationRequest(
  ctx: HostContext,
  params: Record<string, string>,
  search: URLSearchParams,
): Promise<InstallationRequest> {
  return { ...(await baseRequest(ctx, params, search)), organizationId: null };
}
