/**
 * findAuthAccountByEmail pages through the Auth admin list and never reads
 * "no account" from a list it could not finish.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findAuthAccountByEmail, isEmailExistsError } from "../find-account";

type Page = { data: { users: { id: string; email?: string }[] } | null; error: { message: string } | null };

function svcWith(pages: (page: number) => Page) {
  const listUsers = vi.fn(async ({ page }: { page: number; perPage: number }) => pages(page));
  return { svc: { auth: { admin: { listUsers } } } as unknown as SupabaseClient, listUsers };
}

const fullPage = (page: number) =>
  Array.from({ length: 1000 }, (_, i) => ({ id: `u-${page}-${i}`, email: `person-${page}-${i}@example.test` }));

describe("findAuthAccountByEmail", () => {
  it("finds an account on a later page, comparing addresses lowercased", async () => {
    const { svc, listUsers } = svcWith((page) => ({
      data: { users: page === 3 ? [{ id: "target", email: "Renter@Example.TEST" }] : fullPage(page) },
      error: null,
    }));
    expect(await findAuthAccountByEmail(svc, "renter@example.test")).toEqual({
      ok: true,
      user: { id: "target", email: "Renter@Example.TEST" },
    });
    expect(listUsers.mock.calls.map(([args]) => args)).toEqual([
      { page: 1, perPage: 1000 },
      { page: 2, perPage: 1000 },
      { page: 3, perPage: 1000 },
    ]);
  });

  it("answers no account once a page is shorter than a full page", async () => {
    const { svc, listUsers } = svcWith((page) => ({
      data: { users: page === 1 ? fullPage(1) : [{ id: "other", email: "other@example.test" }] },
      error: null,
    }));
    expect(await findAuthAccountByEmail(svc, "renter@example.test")).toEqual({ ok: true, user: null });
    expect(listUsers).toHaveBeenCalledTimes(2);
  });

  it("fails rather than answering no account when a page cannot be read", async () => {
    const { svc } = svcWith((page) =>
      page === 1 ? { data: { users: fullPage(1) }, error: null } : { data: null, error: { message: "down" } }
    );
    expect(await findAuthAccountByEmail(svc, "renter@example.test")).toEqual({ ok: false });
  });

  it("fails rather than answering no account past its page limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { svc, listUsers } = svcWith((page) => ({ data: { users: fullPage(page) }, error: null }));
    expect(await findAuthAccountByEmail(svc, "renter@example.test")).toEqual({ ok: false });
    expect(listUsers).toHaveBeenCalledTimes(50);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("renter");
    warn.mockRestore();
  });
});

describe("isEmailExistsError", () => {
  it.each([
    [{ code: "email_exists", message: "" }, true],
    [{ message: "A user with this email address has already been registered" }, true],
    [{ message: "User already exists" }, true],
    [{ code: "unexpected_failure", message: "Database error creating new user" }, false],
  ])("%j → %s", (error, expected) => {
    expect(isEmailExistsError(error)).toBe(expected);
  });
});
