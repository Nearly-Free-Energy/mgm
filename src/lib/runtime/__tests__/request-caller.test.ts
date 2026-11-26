/**
 * MgmRequest.caller (RFC #259 § 2): openOrganizationScope reads who is
 * calling from the request's client, never from the composer, so every
 * capability plugin sees the kind the resolver recorded.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER, recordCaller } from "../caller";
import { resetMgmRuntimeForTests } from "../root";
import { openOrganizationScope } from "../scope";
import type { MgmRequest } from "../services";

const ORG = "550e8400-e29b-41d4-a716-44665544000a";
const CLIENT = "550e8400-e29b-41d4-a716-4466554400c1";

afterEach(async () => {
  await resetMgmRuntimeForTests();
});

describe("openOrganizationScope's caller", () => {
  it("is the caller recorded for the request's client", async () => {
    const supabase = {};
    recordCaller(supabase, { kind: "operator", clientId: CLIENT });
    const scope = await openOrganizationScope({ organizationId: ORG, userId: "user-1", roles: [], supabase: supabase as never });
    try {
      expect(scope.request.caller).toEqual({ kind: "operator", clientId: CLIENT });
      expect(scope.ctx.get("mgmRequest")?.caller).toEqual({ kind: "operator", clientId: CLIENT });
    } finally {
      await scope.dispose();
    }
  });

  it("is a browser session for a client createClient did not make", async () => {
    const scope = await openOrganizationScope({ organizationId: ORG, userId: null, roles: [], supabase: {} as never });
    try {
      expect(scope.request.caller).toBe(BROWSER);
    } finally {
      await scope.dispose();
    }
  });

  it("cannot be relabelled by the composer", async () => {
    const supabase = {};
    recordCaller(supabase, { kind: "agent", clientId: CLIENT });
    const forged = { organizationId: ORG, userId: "user-1", roles: [], supabase, caller: BROWSER } as unknown as Omit<MgmRequest, "audience" | "caller">;
    const scope = await openOrganizationScope(forged);
    try {
      expect(scope.request.caller).toEqual({ kind: "agent", clientId: CLIENT });
    } finally {
      await scope.dispose();
    }
  });
});
