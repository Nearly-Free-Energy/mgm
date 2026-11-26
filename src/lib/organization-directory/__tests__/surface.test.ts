/**
 * The organization directory's described actions (../surface.ts), one row
 * each: the route, what binds it, its risk, confirmation and what a repeat
 * does; and the `org.user` entity kind and the two available() checks,
 * against a faked client. gui-surface.test.ts holds each action to its route
 * file, schema and release; repeat.db.test.ts sends each "safe" one twice;
 * actions.db.test.ts prepares them and resolves people against a database.
 */
import { describe, expect, it } from "vitest";
import type { ActionDef, InstallationRequest, SurfaceRequest } from "@/lib/gui/surface";
import type { UserRoleRecord } from "@/lib/types/domain";
import { ORGANIZATION_DIRECTORY_SURFACE, USER_KIND } from "../surface";
import { prepareSaveEmailSender } from "../surface/organizations";
import { prepareChangeRole, prepareRemoveUser, userOrganization } from "../surface/users";

const ACTIONS = ORGANIZATION_DIRECTORY_SURFACE.actions as ActionDef[];
const action = (id: string) => ACTIONS.find((a) => a.id === id)!;

describe("the organization directory's actions", () => {
  it("describe each write route once, as these rows say", () => {
    const rows = ACTIONS.map((a) => [a.id, a.method, a.path, a.target, a.bind, a.risk, a.confirm, a.repeat, !!a.prepare, !!a.available]);
    const org = { path: { id: "organization" } };
    const user = { path: { id: USER_KIND } };
    expect(rows).toEqual([
      ["org.update-organization", "PATCH", "/api/organizations/[id]", "organization", org, "write", "none", "safe", false, true],
      ["org.delete-organization", "DELETE", "/api/organizations/[id]", "organization", org, "destructive", "typed", "safe", true, false],
      ["org.save-email-sender", "PUT", "/api/organizations/[id]/email-sender", "organization", org, "external", "confirm", "safe", true, false],
      ["org.remove-email-sender", "DELETE", "/api/organizations/[id]/email-sender", "organization", org, "destructive", "typed", "safe", true, false],
      ["org.set-plugin", "PATCH", "/api/organizations/[id]/plugins", "organization", org, "write", "confirm", "safe", false, false],
      ["org.invite-user", "POST", "/api/users/invite", "organization", { body: { scope_id: "organization" } }, "external", "confirm", "safe", true, false],
      ["org.resend-invite", "POST", "/api/users/[id]/resend-invite", USER_KIND, user, "external", "confirm", "unsafe", true, false],
      ["org.change-role", "PATCH", "/api/users/[id]/role", USER_KIND, user, "write", "ceremony", "unsafe", true, false],
      ["org.update-profile", "PATCH", "/api/users/[id]/profile", USER_KIND, user, "write", "none", "safe", false, true],
      ["org.remove-user", "DELETE", "/api/users/[id]", USER_KIND, user, "destructive", "typed", "safe", true, false],
    ]);
  });

  it("are all human-only and offered only where a view links them", () => {
    for (const a of ACTIONS) expect([a.id, a.humanOnly, a.targeted], a.id).toEqual([a.id, true, false]);
  });

  it("prepare again only when removing the mail sender meets a version conflict", () => {
    expect(action("org.remove-email-sender").prepareAgainOn).toEqual(["version_conflict"]);
    expect(ACTIONS.filter((a) => a.prepareAgainOn?.length).map((a) => a.id)).toEqual(["org.remove-email-sender"]);
  });

  it("declare the person kind the user routes' paths name", () => {
    expect(ORGANIZATION_DIRECTORY_SURFACE.entities?.map((e) => e.kind)).toEqual(["org.user"]);
  });
});

const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const role = (r: string, scope_id: string | null) => ({ role: r, scope_type: "org", scope_id }) as unknown as UserRoleRecord;
const asCaller = (roles: UserRoleRecord[]) => ({ user: { id: SELF }, roles }) as unknown as SurfaceRequest;

describe("available()", () => {
  it("offers editing an organization to super admins only, with the route's reason to anyone else", async () => {
    const available = action("org.update-organization").available!;
    expect(await available(asCaller([role("super_admin", null)]), [ORG])).toEqual({ [ORG]: true });
    expect(await available(asCaller([role("org_manager", ORG)]), [ORG])).toEqual({
      [ORG]: "Only super_admin users can update organizations.",
    });
  });

  it("offers editing a profile for one's own, or anyone's to a super admin", async () => {
    const available = action("org.update-profile").available!;
    expect(await available(asCaller([role("org_manager", ORG)]), [SELF, OTHER])).toEqual({
      [SELF]: true,
      [OTHER]: "Not authorized to update this profile.",
    });
    expect(await available(asCaller([role("super_admin", null)]), [SELF, OTHER])).toEqual({ [SELF]: true, [OTHER]: true });
  });
});

describe("prepare refusals that read nothing", () => {
  /** A caller whose client throws on any read, so a refusal is shown to come first. */
  const reading = (over: Record<string, unknown>) =>
    ({
      supabase: {
        rpc: () => {
          throw new Error("read the person");
        },
        from: () => {
          throw new Error("read a table");
        },
      },
      ...over,
    }) as unknown as SurfaceRequest;

  it("refuses removing a person to an org manager with the route's 403, before reading them", async () => {
    const req = reading({ user: { id: SELF }, roles: [role("org_manager", ORG)] });
    expect(await prepareRemoveUser(req, { params: { id: OTHER } })).toEqual({
      ok: false,
      status: 403,
      message: "No roles revoked (not authorized, or user has no roles).",
    });
  });

  it("refuses changing a role to an org manager with the function's 403, before reading anyone", async () => {
    const req = reading({ user: { id: SELF }, roles: [role("org_manager", ORG)] });
    expect(await prepareChangeRole(req, { params: { id: OTHER }, body: { role: "org_manager", scope_id: ORG } })).toEqual({
      ok: false,
      status: 403,
      message: "Only super admins can change roles.",
    });
  });

  it("refuses saving a mail sender when the caller's account has no address for the test email", async () => {
    const req = reading({ user: { id: SELF }, roles: [role("org_manager", ORG)] });
    expect(await prepareSaveEmailSender(req, { params: { id: ORG } })).toEqual({
      ok: false,
      status: 409,
      message: "Your account has no email address to send the test to.",
    });
  });
});

describe("userOrganization (the org.user kind)", () => {
  /** A request whose client lists `rows` from fn_list_visible_users, recording what it was asked. */
  function request(rows: unknown[] | Error) {
    const asked: unknown[] = [];
    const supabase = {
      rpc: async (name: string, args: unknown) => {
        expect(name).toBe("fn_list_visible_users");
        asked.push(args);
        return rows instanceof Error ? { data: null, error: { message: rows.message } } : { data: rows, error: null };
      },
      from: () => {
        throw new Error("userOrganization reads no table");
      },
    };
    return { req: { supabase, params: {} } as unknown as InstallationRequest, asked };
  }
  const listed = (over: Record<string, unknown>) => ({ user_id: OTHER, email: "a@example.test", role: "org_manager", scope_type: "org", scope_id: ORG, ...over });

  it("is the organization of an org manager row, as the caller's own list shows it", async () => {
    const { req, asked } = request([listed({})]);
    expect(await userOrganization(req, OTHER)).toBe(ORG);
    expect(asked).toEqual([{ _target_user_ids: [OTHER] }]);
  });

  it.each([
    ["not listed to the caller", []],
    ["a super admin, whose row names no organization", [listed({ role: "super_admin", scope_id: null })]],
    ["an account with no row", [listed({ role: null, scope_type: null, scope_id: null })]],
    ["listed with a tenant role, which the function never returns", [listed({ role: "tenant", scope_type: "tenant" })]],
    ["listed under another id", [listed({ user_id: SELF })]],
  ])("is null for a person %s", async (_what, rows) => {
    expect(await userOrganization(request(rows).req, OTHER)).toBeNull();
  });

  it("asks nothing for an id that is not a UUID, and throws when the list cannot be read", async () => {
    const { req, asked } = request([listed({})]);
    expect(await userOrganization(req, "not-a-uuid")).toBeNull();
    expect(asked).toEqual([]);
    await expect(userOrganization(request(new Error("boom")).req, OTHER)).rejects.toThrow("boom");
  });
});
