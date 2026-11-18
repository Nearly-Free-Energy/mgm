/**
 * resolveActorRole: the staff role an entity delete is logged under, and
 * none for a caller who holds no staff role (RFC mgm#197: a tenant row is a
 * person's own unit), which the delete routes answer with 403.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRoleRecord } from "@/lib/types/domain";

const getCurrentUserRoles = vi.fn();
vi.mock("@/lib/auth/access", () => ({ getCurrentUserRoles: (...args: unknown[]) => getCurrentUserRoles(...args) }));

import { resolveActorRole } from "../shared";

const row = (role: string, scope_type: string, scope_id: string | null) =>
  ({ user_id: "u1", role, scope_type, scope_id }) as UserRoleRecord;
const SUPER = row("super_admin", "org", null);
const MANAGER = row("org_manager", "org", "org-a");
const TENANT_ROW = row("tenant", "tenant", "unit-1");
const supabase = {} as SupabaseClient;

beforeEach(() => getCurrentUserRoles.mockReset());

describe("resolveActorRole", () => {
  it("names super_admin over org_manager, whatever tenant rows the person holds", async () => {
    getCurrentUserRoles.mockResolvedValue([TENANT_ROW, MANAGER, SUPER]);
    await expect(resolveActorRole(supabase)).resolves.toBe("super_admin");
    getCurrentUserRoles.mockResolvedValue([TENANT_ROW, MANAGER]);
    await expect(resolveActorRole(supabase)).resolves.toBe("org_manager");
  });

  it("is null for a person whose rows are all tenant rows, and for one with none", async () => {
    getCurrentUserRoles.mockResolvedValue([TENANT_ROW, row("tenant", "tenant", "unit-2")]);
    await expect(resolveActorRole(supabase)).resolves.toBeNull();
    getCurrentUserRoles.mockResolvedValue([]);
    await expect(resolveActorRole(supabase)).resolves.toBeNull();
    expect(getCurrentUserRoles).toHaveBeenCalledWith(supabase);
  });
});
