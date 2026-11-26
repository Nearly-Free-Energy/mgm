/**
 * DELETE /api/users/[id] — removes a person's staff access (UX5 / #79).
 *
 * The user-bound client is faked; it answers fn_list_visible_users with the
 * listing the caller would see, records the delete's filters and answers
 * with the count the database would. What row-level security, the listing
 * and the user_roles triggers decide is covered by rls.test.ts and
 * tenant_access.test.ts. Here: only staff rows are deleted, never a tenant
 * row (RFC mgm#197); the person's address, typed, is required for anyone
 * the caller is listed (org.remove-user is a typed action); and a person the
 * caller is not listed, or with no staff row, gets the same 403 as a caller
 * who may not revoke, whatever confirmation the body carries, so the answer
 * never tells that an account exists or holds tenant access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Filter = [op: string, column: string, value: unknown];
type Listed = { user_id: string; email: string | null; role: string | null };
let filters: Filter[];
let deleteOptions: unknown;
let deletes: number;
let answer: { error: { code?: string; message: string } | null; count: number | null };
let listing: { data: Listed[] | null; error: { message: string } | null };
let listedWith: unknown[];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: unknown) => {
      if (name !== "fn_list_visible_users") throw new Error(`Unexpected rpc: ${name}`);
      listedWith.push(args);
      return listing;
    },
    from: (table: string) => {
      if (table !== "user_roles") throw new Error(`Unexpected table: ${table}`);
      return {
        delete: (options: unknown) => {
          deletes += 1;
          deleteOptions = options;
          const chain = {
            eq: (column: string, value: unknown) => (filters.push(["eq", column, value]), chain),
            neq: (column: string, value: unknown) => (filters.push(["neq", column, value]), chain),
            then: (resolve: (r: typeof answer) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve(answer).then(resolve, reject),
          };
          return chain;
        },
      };
    },
  }),
}));

import { DELETE } from "../route";

const TARGET = "22222222-2222-4000-8000-000000000002";
const EMAIL = "manager@example.test";
const TYPED = { confirmation: { acknowledged: [], typed: EMAIL } };
const NOT_REVOKED = { error: "No roles revoked (not authorized, or user has no roles)." };
/** A DELETE with no body at all. */
const NO_BODY = Symbol("no body");
const remove = (id: string, body: unknown = TYPED) =>
  DELETE(
    new NextRequest(`http://localhost/api/users/${id}`, {
      method: "DELETE",
      ...(body === NO_BODY ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
    { params: Promise.resolve({ id }) }
  );

beforeEach(() => {
  filters = [];
  deleteOptions = undefined;
  deletes = 0;
  listedWith = [];
  answer = { error: null, count: 1 };
  listing = { data: [{ user_id: TARGET, email: EMAIL, role: "org_manager" }], error: null };
});

describe("DELETE /api/users/[id]", () => {
  it("deletes the person's staff rows only, leaving their tenant rows, and answers 204", async () => {
    const res = await remove(TARGET);
    expect(res.status).toBe(204);
    expect(listedWith).toEqual([{ _target_user_ids: [TARGET] }]);
    expect(deleteOptions).toEqual({ count: "exact" });
    expect(filters).toEqual([
      ["eq", "user_id", TARGET],
      ["neq", "role", "tenant"],
    ]);
  });

  it("answers a person with only tenant rows as one the caller may not revoke", async () => {
    // Nothing matched: the person holds no staff row, or row-level security
    // hid them. The same 403 and words either way.
    answer = { error: null, count: 0 };
    const res = await remove(TARGET);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(NOT_REVOKED);
  });

  it("maps the guards' errors and refuses a malformed id before any delete", async () => {
    answer = { error: { code: "40000", message: "Cannot remove the last super admin." }, count: null };
    expect((await remove(TARGET)).status).toBe(409);
    answer = { error: { code: "42501", message: "Cannot revoke your own access." }, count: null };
    expect((await remove(TARGET)).status).toBe(403);
    filters = [];
    expect((await remove("not-a-uuid")).status).toBe(400);
    expect(filters).toEqual([]);
  });

  it("requires the person's address, typed, naming it, and deletes nothing without it", async () => {
    for (const body of [NO_BODY, {}]) {
      const res = await remove(TARGET, body);
      expect(res.status).toBe(428);
      expect(await res.json()).toEqual({
        error: `Type the person's email address, ${EMAIL}, to remove their access.`,
        code: "user_remove_confirmation_required",
      });
    }
    const wrong = await remove(TARGET, { confirmation: { acknowledged: [], typed: "other@example.test" } });
    expect(wrong.status).toBe(428);
    expect(await wrong.json()).toMatchObject({ code: "user_remove_email_mismatch", field: "confirmation" });
    expect(deletes).toBe(0);
    // Case and outer spaces are not the person's to get right.
    expect((await remove(TARGET, { confirmation: { acknowledged: [], typed: " Manager@Example.TEST " } })).status).toBe(204);
  });

  it.each([
    ["not listed to the caller", []],
    ["listed with a tenant role, which the function never returns", [{ user_id: TARGET, email: EMAIL, role: "tenant" }]],
    // Only the person the path names is read from the listing, never its first row.
    ["not listed, while someone else is", [{ user_id: "e7100000-0000-4000-8fff-0000000000aa", email: "other@example.test", role: "org_manager" }]],
  ])("answers a person %s with the same 403, whatever confirmation it carries, deleting nothing", async (_what, rows) => {
    listing = { data: rows, error: null };
    for (const body of [NO_BODY, {}, TYPED]) {
      const res = await remove(TARGET, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(NOT_REVOKED);
    }
    expect(deletes).toBe(0);
  });

  it("refuses a body that is not RemoveUserBody before reading anyone, and a listing that fails with a 500", async () => {
    const bad = await remove(TARGET, { typed: EMAIL });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_body" });
    expect(listedWith).toEqual([]);

    listing = { data: null, error: { message: "boom" } };
    const failed = await remove(TARGET);
    expect(failed.status).toBe(500);
    expect(deletes).toBe(0);
  });
});
