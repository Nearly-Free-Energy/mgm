/**
 * The route side of the resolver (RFC #259 § 2): createClient builds a
 * client on a bearer token only when middleware accepted it (its mark, a MAC
 * of the token under a server-only key, matches) and client tokens are on,
 * records its
 * caller, and sends the token to Supabase Auth on getUser(), so every
 * getUser()-backed session check (CLAUDE.md "Session checks before
 * privilege") asks Auth about the token and refuses a revoked client. No
 * other source builds a client on a bearer token.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentUserAccess } from "@/lib/auth/access";
import { callerOf } from "../caller";
import { CREDENTIAL_HEADER, credentialMark } from "../credential";
import { bearerClientFor } from "../request-session";
import { CLIENT_ID, USER_ID, agentClaims, browserClaims, operatorClaims, tokenWith } from "./token-fixtures";

const REPO = path.resolve(__dirname, "../../../..");
const SUPABASE = "http://127.0.0.1:54321";
const TOKEN = tokenWith(operatorClaims());
const MARK_KEY = "service-role-key-for-the-mark";

/** The headers middleware passes on for a token it accepted. */
const accepted = (token = TOKEN) =>
  new Headers({ authorization: `Bearer ${token}`, [CREDENTIAL_HEADER]: credentialMark(token, { SUPABASE_SERVICE_ROLE_KEY: MARK_KEY })! });

beforeEach(() => {
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", SUPABASE);
  vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", MARK_KEY);
  vi.stubEnv("MGM_CLIENT_TOKENS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("bearerClientFor", () => {
  it("returns null for a request with no bearer token, so the cookie client is built", () => {
    expect(bearerClientFor(new Headers())).toBeNull();
    expect(bearerClientFor(new Headers({ authorization: "Basic dXNlcjpwYXNz" }))).toBeNull();
    // The mark alone builds nothing.
    expect(bearerClientFor(new Headers({ [CREDENTIAL_HEADER]: accepted().get(CREDENTIAL_HEADER)! }))).toBeNull();
  });

  it("throws for a bearer token middleware did not mark: a page, or a request that skipped it", () => {
    expect(() => bearerClientFor(new Headers({ authorization: `Bearer ${TOKEN}` }))).toThrow(/middleware did not accept/);
  });

  // A page or route the middleware matcher skips gets no mark from middleware,
  // and nothing deletes one the client sent. Only the server-only key makes a
  // mark that matches, so one the client set by hand is refused.
  it.each([
    ["the mark's old fixed value", () => "bearer"],
    ["an empty mark", () => ""],
    ["the mark of another token", () => accepted(tokenWith(agentClaims())).get(CREDENTIAL_HEADER)!],
    ["a mark made with another key", () => credentialMark(TOKEN, { SUPABASE_SERVICE_ROLE_KEY: "another-key" })!],
  ])("refuses a mark the client set by hand, with no middleware: %s", (_label, mark) => {
    expect(() => bearerClientFor(new Headers({ authorization: `Bearer ${TOKEN}`, [CREDENTIAL_HEADER]: mark() }))).toThrow(
      /middleware did not accept/,
    );
  });

  it("refuses every mark while the server holds no key to check it with", () => {
    const headers = accepted();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => bearerClientFor(headers)).toThrow(/middleware did not accept/);
  });

  it.each(["off", "0", "nonsense"])("refuses a marked token while MGM_CLIENT_TOKENS is %s", (value) => {
    vi.stubEnv("MGM_CLIENT_TOKENS", value);
    expect(() => bearerClientFor(accepted())).toThrow(/MGM_CLIENT_TOKENS is off/);
  });

  it.each([
    ["a malformed token", "abc"],
    ["a browser session's token", tokenWith(browserClaims())],
    ["a client token with no kind", tokenWith(operatorClaims({ mgm_client_kind: undefined }))],
  ])("throws for %s even when marked", (_label, token) => {
    expect(() => bearerClientFor(accepted(token))).toThrow();
  });

  it("records the caller the token's claims name", () => {
    expect(callerOf(bearerClientFor(accepted())!)).toEqual({ kind: "operator", clientId: CLIENT_ID });
    expect(callerOf(bearerClientFor(accepted(tokenWith(agentClaims())))!)).toEqual({ kind: "agent", clientId: CLIENT_ID });
  });

  it("sends the token to Supabase Auth on getUser(), and to PostgREST, so the person's session checks ask about it", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
        if (url.endsWith("/auth/v1/user")) {
          return new Response(JSON.stringify({ id: USER_ID, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const client = bearerClientFor(accepted())!;
    const access = await getCurrentUserAccess(client);
    expect(access.user?.id).toBe(USER_ID);
    expect(seen.map((s) => [new URL(s.url).pathname, s.authorization])).toEqual([
      ["/auth/v1/user", `Bearer ${TOKEN}`],
      ["/rest/v1/user_roles", `Bearer ${TOKEN}`],
    ]);
  });

  it("refuses the session when Supabase Auth refuses the token, as for a revoked client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: 403, error_code: "session_not_found", msg: "Session not found" }), { status: 403 })),
    );
    expect(await getCurrentUserAccess(bearerClientFor(accepted())!)).toEqual({ user: null, roles: [] });
  });
});

describe("a client on a bearer token", () => {
  // Every client token reaches MGM's code through createClient. A second
  // place that builds one would make a client whose caller is not recorded,
  // and callerOf would read it as a browser session.
  it("is built only by bearerClientFor", () => {
    const builders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(rel);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = readFileSync(path.join(REPO, rel), "utf8");
          if (/global\s*:\s*\{[^}]*headers\s*:\s*\{[^}]*Authorization/.test(text)) builders.push(rel);
        }
      }
    };
    walk("src");
    expect(builders).toEqual(["src/lib/runtime/request-session.ts"]);
  });
});
