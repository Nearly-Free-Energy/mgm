/**
 * TenantAccessGrantBody: one address, trimmed and lowercased, and no other
 * field, so no caller names an account by id.
 */
import { describe, expect, it } from "vitest";
import { TenantAccessGrantBody } from "../schemas";

describe("TenantAccessGrantBody", () => {
  it("trims and lowercases the address, and folds nothing else", () => {
    expect(TenantAccessGrantBody.parse({ email: "  Renter.Name+Unit@Example.TEST " })).toEqual({
      email: "renter.name+unit@example.test",
    });
  });

  it.each([
    [{}, "Enter a valid email address.", "email"],
    [{ email: 42 }, "Enter a valid email address.", "email"],
    [{ email: "" }, "Enter a valid email address.", "email"],
    [{ email: "not-an-address" }, "Enter a valid email address.", "email"],
    [{ email: `${"a".repeat(250)}@example.test` }, "Enter a valid email address.", "email"],
    [{ email: "renter@example.test", user_id: "00000000-0000-4000-8000-000000000001" }, "Unknown field: user_id", undefined],
    [null, "Request body must be an object", undefined],
  ])("refuses %j", (body, message, field) => {
    const parsed = TenantAccessGrantBody.safeParse(body);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const [issue] = parsed.error.issues;
    expect(issue.message).toBe(message);
    expect(typeof issue.path[0] === "string" ? issue.path[0] : undefined).toBe(field);
  });
});
