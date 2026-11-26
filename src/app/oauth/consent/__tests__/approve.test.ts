/**
 * The consent page's Connect sequence (#271, ADR-008 decisions 2 and 3):
 * record first, then ask Supabase Auth, then follow only this site's code
 * page. The same sequence against a real Supabase Auth is
 * src/app/api/auth/oauth/approvals/__tests__/sign-in.db.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { approveSignIn, type ApproveDeps } from "../approve";

const ID = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
const SITE = "https://mgm.example.org";
const CODE_URL = `${SITE}/oauth/code?code=3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b&state=s`;

function deps(over: {
  record?: Response | Error;
  details?: unknown;
  approved?: unknown;
} = {}) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    calls.push(`record ${input} ${init.body}`);
    if (over.record instanceof Error) throw over.record;
    return over.record ?? Response.json({ client_id: "c-1", kind: "operator" }, { status: 201 });
  });
  const getAuthorizationDetails = vi.fn(async () => {
    calls.push("details");
    return over.details ?? { data: { redirect_url: CODE_URL }, error: null };
  });
  const approveAuthorization = vi.fn(async (_id: string, options?: { skipBrowserRedirect?: boolean }) => {
    calls.push(`approve skip=${options?.skipBrowserRedirect}`);
    return over.approved ?? { data: { redirect_url: CODE_URL }, error: null };
  });
  const d = { fetch, oauth: { getAuthorizationDetails, approveAuthorization }, siteOrigin: SITE } as unknown as ApproveDeps;
  return { d, calls, fetch, getAuthorizationDetails, approveAuthorization };
}

const pending = { data: { authorization_id: ID, client: { id: "c-1" }, redirect_uri: `${SITE}/oauth/code` }, error: null };

describe("approveSignIn", () => {
  it("records the approval, then follows the code page Supabase Auth answers with for a client approved before", async () => {
    const { d, calls } = deps();
    expect(await approveSignIn(ID, d)).toEqual({ ok: true, redirectUrl: CODE_URL });
    expect(calls).toEqual([`record /api/auth/oauth/approvals {"authorization_id":"${ID}"}`, "details"]);
  });

  it("approves a sign-in Supabase Auth asks about, without letting it navigate", async () => {
    const { d, calls } = deps({ details: pending });
    expect(await approveSignIn(ID, d)).toEqual({ ok: true, redirectUrl: CODE_URL });
    expect(calls.slice(1)).toEqual(["details", "approve skip=true"]);
  });

  it("asks Supabase Auth nothing when MGM refuses to record, and shows MGM's reason", async () => {
    const { d, getAuthorizationDetails, approveAuthorization } = deps({
      record: Response.json({ error: "This sign-in has expired. Run mgm login again." }, { status: 410 }),
    });
    expect(await approveSignIn(ID, d)).toEqual({ ok: false, message: "This sign-in has expired. Run mgm login again." });
    expect(getAuthorizationDetails).not.toHaveBeenCalled();
    expect(approveAuthorization).not.toHaveBeenCalled();
  });

  it("asks Supabase Auth nothing when MGM cannot be reached", async () => {
    const { d, getAuthorizationDetails } = deps({ record: new Error("offline") });
    expect(await approveSignIn(ID, d)).toMatchObject({ ok: false, message: expect.stringMatching(/could not be reached/) });
    expect(getAuthorizationDetails).not.toHaveBeenCalled();
  });

  it("does not approve when Supabase Auth names a client other than the one recorded", async () => {
    const { d, approveAuthorization } = deps({ details: { ...pending, data: { ...pending.data, client: { id: "c-2" } } } });
    expect(await approveSignIn(ID, d)).toMatchObject({ ok: false });
    expect(approveAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    ["another site", "https://evil.example/oauth/code?code=x"],
    ["another page of this site", `${SITE}/somewhere?code=x`],
  ])("refuses to follow %s", async (_name, url) => {
    const auto = deps({ details: { data: { redirect_url: url }, error: null } });
    expect(await approveSignIn(ID, auto.d)).toMatchObject({ ok: false, message: expect.stringMatching(/other than this site/) });
    const asked = deps({ details: pending, approved: { data: { redirect_url: url }, error: null } });
    expect(await approveSignIn(ID, asked.d)).toMatchObject({ ok: false });
  });

  it("stops when Supabase Auth refuses either call", async () => {
    const details = deps({ details: { data: null, error: { message: "no" } } });
    expect(await approveSignIn(ID, details.d)).toMatchObject({ ok: false });
    const approve = deps({ details: pending, approved: { data: null, error: { message: "no" } } });
    expect(await approveSignIn(ID, approve.d)).toMatchObject({ ok: false });
  });
});
