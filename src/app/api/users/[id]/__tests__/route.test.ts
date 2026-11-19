/**
 * DELETE /api/users/[id] — removes a person's staff access (UX5 / #79).
 *
 * The user-bound client is faked; it records the delete's filters and
 * answers with the count the database would. What row-level security and
 * the user_roles triggers decide is covered by rls.test.ts. Here: only staff
 * rows are deleted, never a tenant row (RFC mgm#197), and a person with no
 * staff row gets the same 403 as a caller who may not revoke, so the answer
 * never tells that an account holds tenant access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Filter = [op: string, column: string, value: unknown];
let filters: Filter[];
let deleteOptions: unknown;
let answer: { error: { code?: string; message: string } | null; count: number | null };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table !== "user_roles") throw new Error(`Unexpected table: ${table}`);
      return {
        delete: (options: unknown) => {
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
const remove = (id: string) =>
  DELETE(new NextRequest(`http://localhost/api/users/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  filters = [];
  deleteOptions = undefined;
  answer = { error: null, count: 1 };
});

describe("DELETE /api/users/[id]", () => {
  it("deletes the person's staff rows only, leaving their tenant rows, and answers 204", async () => {
    const res = await remove(TARGET);
    expect(res.status).toBe(204);
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
    expect(await res.json()).toEqual({ error: "No roles revoked (not authorized, or user has no roles)." });
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
});
