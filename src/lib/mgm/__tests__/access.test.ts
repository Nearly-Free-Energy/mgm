import { afterEach, describe, expect, it } from "vitest";
import { isMgmReviewer } from "../access";

const originalId = process.env.MGM_REVIEW_ALLOWED_USER_ID;
const originalEmail = process.env.MGM_REVIEW_ALLOWED_EMAIL;

afterEach(() => {
  if (originalId === undefined) delete process.env.MGM_REVIEW_ALLOWED_USER_ID;
  else process.env.MGM_REVIEW_ALLOWED_USER_ID = originalId;
  if (originalEmail === undefined) delete process.env.MGM_REVIEW_ALLOWED_EMAIL;
  else process.env.MGM_REVIEW_ALLOWED_EMAIL = originalEmail;
});

describe("MGM reviewer access", () => {
  it("allows only the configured identity", () => {
    process.env.MGM_REVIEW_ALLOWED_EMAIL = "pilot@example.test";
    expect(isMgmReviewer({ id: "1", email: "PILOT@example.test" })).toBe(true);
    expect(isMgmReviewer({ id: "2", email: "other@example.test" })).toBe(false);
  });

  it("prioritizes an exact user id when configured", () => {
    process.env.MGM_REVIEW_ALLOWED_EMAIL = "pilot@example.test";
    process.env.MGM_REVIEW_ALLOWED_USER_ID = "one";
    expect(isMgmReviewer({ id: "one", email: "other@example.test" })).toBe(true);
    expect(isMgmReviewer({ id: "two", email: "pilot@example.test" })).toBe(false);
  });

  it("denies everyone when no reviewer is configured in any environment", () => {
    delete process.env.MGM_REVIEW_ALLOWED_EMAIL;
    delete process.env.MGM_REVIEW_ALLOWED_USER_ID;
    expect(isMgmReviewer({ id: "1", email: "pilot@example.test" })).toBe(false);
  });
});
