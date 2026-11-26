/**
 * PATCH /api/users/[id]/role — a role change, which fn_change_user_role
 * decides (UX5 / #79). Described as org.change-role, whose input
 * (ChangeRoleBody) the route parses with.
 *
 * The user-bound client is faked and records the function's arguments. What
 * the function allows (super admins only, never oneself, the last super
 * admin kept, tenant rows left alone) is covered against the database by
 * rls.test.ts and tenant_access.test.ts. Here: the body's answers, which
 * are the route's from before it parsed with a schema, and that every
 * accepted body reaches the function as the route always called it, even
 * one asking for the role the person holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let calls: { name: string; args: unknown }[];
let answer: { error: { code?: string; message: string } | null };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return answer;
    },
  }),
}));

import { PATCH } from "../route";

const TARGET = "22222222-2222-4000-8000-000000000002";
const ORG = "33333333-3333-4000-8000-000000000003";
const patch = (raw: string, id = TARGET) =>
  PATCH(
    new NextRequest(`http://localhost/api/users/${id}/role`, {
      method: "PATCH",
      body: raw,
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) }
  );
const json = (body: unknown) => JSON.stringify(body);
const ROLE = { error: "Role must be one of 'super_admin' or 'org_manager'." };

beforeEach(() => {
  calls = [];
  answer = { error: null };
});

describe("PATCH /api/users/[id]/role", () => {
  it("calls fn_change_user_role with the role and organization, as the Users page sends them", async () => {
    const res = await patch(json({ role: "org_manager", scope_id: ORG }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ name: "fn_change_user_role", args: { p_user_id: TARGET, p_role: "org_manager", p_scope_id: ORG } }]);
  });

  it("gives a super admin no organization, whatever scope_id says, and takes the host's ceremony confirmation", async () => {
    const res = await patch(json({ role: "super_admin", scope_id: null, confirmation: { acknowledged: [] } }));
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ name: "fn_change_user_role", args: { p_user_id: TARGET, p_role: "super_admin", p_scope_id: undefined } }]);
  });

  it("calls the function again for a second identical send: the route adds no shortcut", async () => {
    await patch(json({ role: "org_manager", scope_id: ORG }));
    await patch(json({ role: "org_manager", scope_id: ORG }));
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["a body that is not JSON", "{", 400, { error: "Invalid JSON body" }],
    ["no role", json({}), 422, ROLE],
    ["the tenant role", json({ role: "tenant", scope_id: null }), 422, ROLE],
    ["null, on which the route failed", "null", 422, ROLE],
    ["an org_manager with no organization", json({ role: "org_manager" }), 422, { error: "org_manager requires a scope_id (org).", field: "scope_id" }],
    ["an org_manager with a malformed organization", json({ role: "org_manager", scope_id: "x" }), 422, { error: "org_manager requires a scope_id (org).", field: "scope_id" }],
    ["a field the route does not read", json({ role: "super_admin", user_id: TARGET }), 400, { error: "Unknown field: user_id", code: "invalid_body" }],
    ["a confirmation with something typed", json({ role: "super_admin", confirmation: { acknowledged: [], typed: "x" } }), 400, null],
  ])("refuses %s without calling the function", async (_what, raw, status, body) => {
    const res = await patch(raw);
    expect(res.status).toBe(status);
    if (body) expect(await res.json()).toEqual(body);
    expect(calls).toEqual([]);
  });

  it("maps the function's refusals", async () => {
    for (const [code, status] of [["42501", 403], ["22023", 422], ["40000", 409], ["XX000", 500]] as const) {
      answer = { error: { code, message: "refused" } };
      const res = await patch(json({ role: "super_admin" }));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: "refused" });
    }
  });

  it("refuses a malformed id before reading the body", async () => {
    expect((await patch("{", "not-a-uuid")).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
