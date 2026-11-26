/**
 * The consent helpers (#271): the authorization id's shape, the code page
 * check the consent page follows, and how the two database answers are read.
 * The functions themselves run in client_consent.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONSENT_PROBLEMS,
  isAuthorizationId,
  isCodePageUrl,
  readClientAuthorization,
  recordClientApproval,
} from "../client-consent";

const ID = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";

function service(answer: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(answer);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe("isAuthorizationId", () => {
  it("accepts Supabase Auth's id of letters and digits", () => {
    expect(isAuthorizationId(ID)).toBe(true);
  });

  it.each([null, undefined, 7, "", "short", `${ID}-`, `${ID}/../x`, "a".repeat(129)])("refuses %s", (value) => {
    expect(isAuthorizationId(value)).toBe(false);
  });
});

describe("isCodePageUrl", () => {
  const site = "https://mgm.example.org";

  it("accepts this site's code page with its query", () => {
    expect(isCodePageUrl(`${site}/oauth/code?code=c&state=s`, site)).toBe(true);
  });

  it.each([
    ["another site", "https://evil.example/oauth/code?code=c"],
    ["another port", "https://mgm.example.org:8443/oauth/code?code=c"],
    ["plain http", "http://mgm.example.org/oauth/code?code=c"],
    ["another page", `${site}/oauth/consent?code=c`],
    ["a longer path", `${site}/oauth/code/x?code=c`],
    ["not a URL", "/oauth/code?code=c"],
  ])("refuses %s", (_name, url) => {
    expect(isCodePageUrl(url, site)).toBe(false);
  });
});

describe("the database answers", () => {
  const ok = { outcome: "ok", client_id: "c-1", kind: "operator", label: "MGM CLI" };

  it.each([
    ["readClientAuthorization", readClientAuthorization, "fn_client_authorization_read"],
    ["recordClientApproval", recordClientApproval, "fn_client_approval_record"],
  ] as const)("%s calls %s for the person and names the client", async (_name, call, fn) => {
    const { client, rpc } = service({ data: [ok], error: null });
    expect(await call(client, ID, "user-1")).toEqual({
      outcome: "ok",
      client: { id: "c-1", kind: "operator", label: "MGM CLI" },
    });
    expect(rpc).toHaveBeenCalledWith(fn, { _authorization_id: ID, _user_id: "user-1" });
  });

  it.each(Object.keys(CONSENT_PROBLEMS))("passes on the refusal %s", async (outcome) => {
    const { client } = service({ data: [{ outcome, client_id: null, kind: null, label: null }], error: null });
    expect(await readClientAuthorization(client, ID, "user-1")).toEqual({ outcome });
  });

  it.each([
    ["no row", []],
    ["an outcome it does not know", [{ outcome: "maybe", client_id: null, kind: null, label: null }]],
    ["a kind it does not know", [{ ...ok, kind: "robot" }]],
  ])("throws on %s rather than guess", async (_name, data) => {
    const { client } = service({ data, error: null });
    await expect(readClientAuthorization(client, ID, "user-1")).rejects.toThrow(/Unexpected consent answer/);
  });

  it("throws when the database refuses the call", async () => {
    const { client } = service({ data: null, error: { message: "permission denied" } });
    await expect(recordClientApproval(client, ID, "user-1")).rejects.toThrow(/permission denied/);
  });
});
