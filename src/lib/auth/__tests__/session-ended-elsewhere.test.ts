/**
 * The access helpers refuse a session Supabase Auth has ended, even though
 * its access token still verifies.
 *
 * Middleware checks only the token's signature (getClaims), and RLS keeps
 * answering for a validly signed token until it expires, so a session signed
 * out on another device still sees its own role rows and its org's rows.
 * Pages and routes gate the service role and stored credentials on these
 * helpers (see src/lib/__tests__/service-role-session-check.test.ts), which
 * is safe only because the helpers ask Auth with getUser(). These tests give
 * the mock client a token that verifies and data RLS would return, with an
 * Auth that has ended the session, so a helper that trusted the claims or
 * the rows instead would fail them.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCurrentUserRoles,
  currentUserIsSuperAdmin,
  currentUserCanAccessOrg,
  currentUserCanAccessCommunity,
  currentUserCanAccessMicrogrid,
} from "../access";
import { authorizeOrganization } from "@/lib/runtime/scope";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

/** Every query chain resolves to `data`, whatever it calls. */
function rows(data: unknown) {
  const result = () => Promise.resolve({ data, error: null });
  function chain(): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "maybeSingle" || prop === "single" || prop === "returns") return result;
        if (prop === "then") {
          return (resolve: (value: { data: unknown; error: null }) => unknown) =>
            result().then(resolve);
        }
        return () => chain();
      },
    });
  }
  return chain();
}

function sessionEndedElsewhere(): SupabaseClient {
  return {
    auth: {
      // The token verifies locally...
      getClaims: async () => ({ data: { claims: { sub: "u1" } }, error: null }),
      getSession: async () => ({
        data: { session: { access_token: "verifies", user: { id: "u1" } } },
        error: null,
      }),
      // ...but Auth no longer knows the session.
      getUser: async () => ({
        data: { user: null },
        error: { name: "AuthApiError", status: 403, code: "session_not_found" },
      }),
    },
    from: (table: string) => {
      if (table === "user_roles") {
        return rows([
          { user_id: "u1", role: "super_admin", scope_type: "org", scope_id: null },
          { user_id: "u1", role: "org_manager", scope_type: "org", scope_id: ORG_ID },
        ]);
      }
      if (table === "microgrids") {
        return rows({ community_id: "c1", communities: { org_id: ORG_ID } });
      }
      return rows({ org_id: ORG_ID });
    },
  } as unknown as SupabaseClient;
}

describe("a session signed out elsewhere, whose token still verifies", () => {
  it("has no roles", async () => {
    expect(await getCurrentUserRoles(sessionEndedElsewhere())).toEqual([]);
  });

  it("is not a super admin", async () => {
    expect(await currentUserIsSuperAdmin(sessionEndedElsewhere())).toBe(false);
  });

  it("cannot access the org, its community or its microgrid", async () => {
    const supabase = sessionEndedElsewhere();
    expect(await currentUserCanAccessOrg(supabase, ORG_ID)).toBe(false);
    expect(await currentUserCanAccessCommunity(supabase, "c1")).toBe(false);
    expect(await currentUserCanAccessMicrogrid(supabase, "mg-1")).toBe(false);
  });

  it("is refused by the composers' authorization step", async () => {
    expect(await authorizeOrganization(sessionEndedElsewhere(), ORG_ID)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
  });
});
