import type { SupabaseClient, User } from "@supabase/supabase-js";
import { vi } from "vitest";
import type { UserRoleRecord } from "@/lib/types/domain";
import type { Fmt } from "../../../surface";
import { hostContext, type HostContext } from "../access";

export const ORG_A = "e7100000-0000-4000-8000-000000000001";
export const ORG_B = "e7100000-0000-4000-8000-000000000002";

const USER = { id: "e7100000-0000-4000-8fff-000000000001", email: "host@test.local" } as User;

function role(r: "super_admin" | "org_manager", scopeId: string | null): UserRoleRecord {
  return {
    id: `role-${r}-${scopeId ?? "all"}`,
    user_id: USER.id,
    role: r,
    scope_type: "org",
    scope_id: scopeId,
    scope_org_id: scopeId,
    scope_microgrid_id: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}
export const managerOf = (orgId: string) => role("org_manager", orgId);
export const superAdmin = () => role("super_admin", null);

/** Enough of Fmt for labels: a date prints as D(<date>), so a label that skips fmt shows. */
export const fakeFmt = { date: (d: string) => ({ t: "date", v: d, text: `D(${d})` }) } as unknown as Fmt;

/** A HostContext over `newClient`, issued by hostContext as routes will. */
export function contextFor(
  roles: UserRoleRecord[],
  newClient: () => Promise<SupabaseClient> = vi.fn(async () => ({}) as SupabaseClient),
): HostContext {
  const made = hostContext({ user: USER, roles }, new Headers({ "accept-language": "en-UG" }), {
    newClient,
    makeFmt: () => fakeFmt,
    now: new Date("2026-11-09T08:00:00Z"),
  });
  if (!made.ok) throw new Error("fixture context refused");
  return made.ctx;
}
