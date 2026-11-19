/**
 * The Supabase Auth account for an address, whatever role rows it holds, or
 * none. It runs on the service client the caller passes, so the caller
 * settles the session before it creates that client; this module creates
 * no client of its own.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";

/** listUsers' largest page. */
const PER_PAGE = 1000;
/**
 * Pages read before giving up, so a lookup ends. Past it the lookup answers
 * { ok: false }, never "no account", which would create a second account
 * for the address.
 */
const MAX_PAGES = 50;

export type AccountLookup = { ok: true; user: User | null } | { ok: false };

/**
 * The account whose address is `email` (compared lowercased), paging through
 * the Auth admin list. Answers { ok: false } when a page cannot be read or
 * the list is longer than MAX_PAGES pages. If Supabase Auth gains a lookup
 * by address, use it here.
 */
export async function findAuthAccountByEmail(
  svc: SupabaseClient,
  email: string
): Promise<AccountLookup> {
  const wanted = email.trim().toLowerCase();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error || !data) return { ok: false };
    const user = data.users.find((u) => u.email?.toLowerCase() === wanted);
    if (user) return { ok: true, user };
    if (data.users.length < PER_PAGE) return { ok: true, user: null };
  }
  console.warn(
    JSON.stringify({ event: "auth.find_account", outcome: "page_limit", pages: MAX_PAGES })
  );
  return { ok: false };
}

/**
 * Whether createUser refused because the address already has an account,
 * across SDK versions: the error code, or its message.
 */
export function isEmailExistsError(error: { message?: string; code?: string }): boolean {
  const msg = error.message?.toLowerCase() ?? "";
  return (
    error.code === "email_exists" ||
    msg.includes("already registered") ||
    msg.includes("already been registered") ||
    msg.includes("user already exists") ||
    msg.includes("already in use")
  );
}
