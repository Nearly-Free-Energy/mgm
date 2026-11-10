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
 *
 * The composers that run authorizeOrganization are trusted the same way:
 * service-role-session-check.test.ts does not list the routes that call
 * them, because they settle the session before they open a request scope,
 * and only a scope loads the plugins that build providers or a service-role
 * repository. The last tests check that ordering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
// The root before any composer: the metering surface's loader imports
// composeMetering, and loaded first from inside the scope mock below it would
// bind the uncounted opener. If the root stops importing surface modules, the
// order no longer matters.
import "@/lib/runtime/root";
import {
  getCurrentUserRoles,
  currentUserIsSuperAdmin,
  currentUserCanAccessOrg,
  currentUserCanAccessCommunity,
  currentUserCanAccessMicrogrid,
} from "../access";
import { authorizeOrganization } from "@/lib/runtime/scope";
import { composeBilling } from "@/lib/billing/compose";
import { composeCommunityManagement } from "@/lib/community-management/compose";
import { composeBillingReview } from "@/lib/cordis/billing-review";
import { composeMetering } from "@/lib/metering/compose";
import { composePayments } from "@/lib/payments/compose";

// Counts request scopes. Every composer imports openOrganizationScope from
// this module, so a scope opened anywhere inside one is counted.
const opened = vi.hoisted(() => ({ scopes: 0 }));
vi.mock("@/lib/runtime/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runtime/scope")>();
  return {
    ...actual,
    openOrganizationScope: (...args: Parameters<typeof actual.openOrganizationScope>) => {
      opened.scopes += 1;
      return actual.openOrganizationScope(...args);
    },
  };
});

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

/** `live` gives the same client an Auth that still knows the session. */
function sessionEndedElsewhere(live = false): SupabaseClient {
  return {
    auth: {
      // The token verifies locally...
      getClaims: async () => ({ data: { claims: { sub: "u1" } }, error: null }),
      getSession: async () => ({
        data: { session: { access_token: "verifies", user: { id: "u1" } } },
        error: null,
      }),
      // ...but Auth no longer knows the session.
      getUser: async () =>
        live
          ? { data: { user: { id: "u1" } }, error: null }
          : { data: { user: null }, error: { name: "AuthApiError", status: 403, code: "session_not_found" } },
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
    // Every plugin is enabled.
    rpc: async () => ({ data: true, error: null }),
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

describe("the composers that check the session themselves", () => {
  beforeEach(() => {
    opened.scopes = 0;
  });

  it.each([
    ["composeMetering", () => composeMetering({ supabase: sessionEndedElsewhere(), organizationId: ORG_ID })],
    ["composeBilling", () => composeBilling({ supabase: sessionEndedElsewhere(), organizationId: ORG_ID })],
    [
      "composeBilling with readOnly",
      () => composeBilling({ supabase: sessionEndedElsewhere(), organizationId: ORG_ID, readOnly: true }),
    ],
    [
      "composeCommunityManagement",
      () => composeCommunityManagement({ supabase: sessionEndedElsewhere(), organizationId: ORG_ID }),
    ],
    ["composePayments", () => composePayments({ supabase: sessionEndedElsewhere(), organizationId: ORG_ID })],
  ])("%s answers 401 without opening a request scope", async (_name, compose) => {
    expect(await compose()).toMatchObject({ ok: false, status: 401 });
    expect(opened.scopes).toBe(0);
  });

  // The counter itself: composeMetering is the composer the root's surface
  // modules import, so a change in import order binds it first. Without this
  // case, a composer holding the unwrapped opener would pass the ones above.
  it("composeMetering opens a counted request scope for a live session", async () => {
    const composed = await composeMetering({ supabase: sessionEndedElsewhere(true), organizationId: ORG_ID });
    if (!composed.ok) throw new Error(composed.code);
    await composed.data.dispose();
    expect(opened.scopes).toBe(1);
  });

  it("composeBillingReview, which leaves the check to its caller, opens one", async () => {
    const composition = await composeBillingReview({
      supabase: sessionEndedElsewhere(),
      organizationId: ORG_ID,
      userId: "u1",
    });
    await composition.dispose();
    expect(opened.scopes).toBe(1);
  });
});
