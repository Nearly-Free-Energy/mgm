import { beforeEach, describe, expect, it, vi } from "vitest";
import { composeMetering } from "../compose";

let user: { id: string } | null = { id: "user-1" };
let roles: unknown[] = [];
let pluginEnabled = true;

vi.mock("@/lib/auth/access", () => ({
  getCurrentUserRoles: async () => roles,
}));

vi.mock("@/lib/plugins/state", () => ({
  isMeteringEnabled: async () => pluginEnabled,
}));

const ORG_ID = "550e8400-e29b-41d4-a716-446655440000";

function makeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user } }) },
  } as never;
}

describe("composeMetering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    user = { id: "user-1" };
    roles = [
      {
        user_id: "user-1",
        role: "org_manager",
        scope_type: "org",
        scope_id: ORG_ID,
      },
    ];
    pluginEnabled = true;
  });

  it("rejects malformed organization ids", async () => {
    const result = await composeMetering({
      supabase: makeSupabase(),
      organizationId: "not-a-uuid",
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("requires authentication", async () => {
    user = null;
    const result = await composeMetering({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects organizations outside the caller's roles", async () => {
    roles = [];
    const result = await composeMetering({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("fails closed when the metering plugin is disabled", async () => {
    pluginEnabled = false;
    const result = await composeMetering({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "metering_disabled",
    });
  });

  it("provides a scoped capability and deactivates it on dispose", async () => {
    const result = await composeMetering({
      supabase: makeSupabase(),
      organizationId: ORG_ID,
    });
    if (!result.ok) throw new Error("expected composition");
    expect(result.data.scope).toMatchObject({
      organizationId: ORG_ID,
      userId: "user-1",
    });

    await result.data.dispose();
    const afterDispose = await result.data.metering.getAssignmentHistory(
      "550e8400-e29b-41d4-a716-446655440010"
    );
    expect(afterDispose).toMatchObject({
      ok: false,
      code: "metering_composition_disposed",
    });
  });
});
