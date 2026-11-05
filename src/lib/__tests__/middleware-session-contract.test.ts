/**
 * Middleware session check against the real @supabase/ssr and auth-js.
 *
 * middleware.test.ts mocks the Supabase client; this file does not, so it
 * pins the library behaviour the middleware relies on: getClaims() verifies
 * an ES256 token locally against a key set it fetches once and caches, never
 * calls Auth's /user for it, refuses a token whose signature, algorithm or
 * claims do not check out, refreshes an expired token through setAll, and
 * falls back to /user for a shared-secret (HS256) token or a key it does not
 * know. If an auth-js upgrade changes any of these, a test here fails.
 *
 * Only fetch is replaced. The signing key is generated per run with
 * WebCrypto. auth-js caches the key set in module state keyed by the cookie
 * name, which vi.resetModules() does not clear, so every test uses its own
 * cookie name.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const SUPABASE_URL = "http://supabase.test";

const b64url = (data: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof data === "string" ? Buffer.from(data) : new Uint8Array(data)).toString(
    "base64url"
  );
const encode = (value: object) => b64url(JSON.stringify(value));
const now = () => Math.floor(Date.now() / 1000);

let signingKey: CryptoKeyPair;
let otherKey: CryptoKeyPair;
let publicJwk: JsonWebKey & { kid: string };

const generateKey = async () =>
  (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

beforeAll(async () => {
  signingKey = await generateKey();
  otherKey = await generateKey();
  publicJwk = {
    ...(await crypto.subtle.exportKey("jwk", signingKey.publicKey)),
    kid: "test-key",
    alg: "ES256",
    use: "sig",
    key_ops: ["verify"],
  };
});

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: "u1",
    role: "authenticated",
    aud: "authenticated",
    session_id: "s1",
    iat: now(),
    exp: now() + 3600,
    ...overrides,
  };
}

async function es256Token(
  payload: object,
  { key = signingKey, header = { alg: "ES256", kid: publicJwk.kid, typ: "JWT" } } = {}
) {
  const encodedHeader = encode(header);
  const body = encode(payload);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    Buffer.from(`${encodedHeader}.${body}`)
  );
  return `${encodedHeader}.${body}.${b64url(signature)}`;
}

function hs256Token(payload: object) {
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.${b64url("signature")}`;
}

function session(accessToken: string, expiresAt = now() + 3600) {
  return {
    access_token: accessToken,
    refresh_token: "refresh-1",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    user: { id: "u1", aud: "authenticated", role: "authenticated" },
  };
}

// What each fake Supabase endpoint answers, and every request made to it.
let calls: string[];
let userEndpoint: "live" | "revoked";
let refreshEndpoint: "issues" | "refuses";

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input instanceof Request ? input.url : input);
  const path = url.slice(SUPABASE_URL.length);
  calls.push(`${init?.method ?? "GET"} ${path}`);
  if (path === "/auth/v1/.well-known/jwks.json") {
    return Response.json({ keys: [publicJwk] });
  }
  if (path === "/auth/v1/user") {
    if (userEndpoint === "revoked") {
      return Response.json(
        { code: "session_not_found", message: "Session from session_id claim in JWT does not exist" },
        { status: 403, headers: { "x-supabase-api-version": "2024-01-01" } }
      );
    }
    return Response.json({ id: "u1", aud: "authenticated", role: "authenticated" });
  }
  if (path.startsWith("/auth/v1/token?grant_type=refresh_token")) {
    if (refreshEndpoint === "refuses") {
      return Response.json(
        { code: "refresh_token_not_found", message: "Invalid Refresh Token: Refresh Token Not Found" },
        { status: 400, headers: { "x-supabase-api-version": "2024-01-01" } }
      );
    }
    return Response.json(session(await es256Token(claims())));
  }
  return new Response("not faked", { status: 599 });
}

let cookieName: string;
let testNumber = 0;

beforeEach(() => {
  calls = [];
  userEndpoint = "live";
  refreshEndpoint = "issues";
  cookieName = `sb-contract-${++testNumber}-auth-token`;
  vi.stubGlobal("fetch", fakeFetch);
  vi.stubEnv("MGM_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("MGM_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_test");
  vi.stubEnv("MGM_PUBLIC_SUPABASE_COOKIE_NAME", cookieName);
  vi.stubEnv("SUPABASE_INTERNAL_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function loadMiddleware() {
  vi.resetModules();
  return (await import("../../middleware")).middleware;
}

function requestWithSession(pathname: string, value: object) {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: { cookie: `${cookieName}=base64-${b64url(JSON.stringify(value))}` },
  });
}

describe("middleware session check with the real Supabase client", () => {
  it("verifies an ES256 token locally: one key-set fetch, then none, and no Auth call", async () => {
    const token = await es256Token(claims());
    const middleware = await loadMiddleware();

    const first = await middleware(requestWithSession("/settings/plugins", session(token)));
    expect(first.status).toBe(200);
    expect(calls).toEqual(["GET /auth/v1/.well-known/jwks.json"]);

    calls = [];
    const second = await middleware(requestWithSession("/api/communities", session(token)));
    expect(second.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("lets a session Auth has ended through until its token expires", async () => {
    // The trade-off getClaims() makes: it does not ask Auth whether the
    // session still exists. Code that acts beyond the token's own grant
    // calls getUser() itself.
    userEndpoint = "revoked";
    const token = await es256Token(claims());
    const middleware = await loadMiddleware();

    const res = await middleware(requestWithSession("/api/communities", session(token)));
    expect(res.status).toBe(200);
    expect(calls).not.toContain("GET /auth/v1/user");
  });

  it("on /login, asks Auth and clears the cookies of a session it has ended", async () => {
    userEndpoint = "revoked";
    const token = await es256Token(claims());
    const middleware = await loadMiddleware();

    const res = await middleware(requestWithSession("/login", session(token)));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(calls).toContain("GET /auth/v1/user");
    expect(res.cookies.get(cookieName)?.value).toBe("");
  });

  it("on /login, sends a live session to /", async () => {
    const token = await es256Token(claims());
    const middleware = await loadMiddleware();

    const res = await middleware(requestWithSession("/login", session(token)));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/");
  });

  it("refreshes an expired access token, returns the new cookies and verifies locally", async () => {
    const expired = await es256Token(claims({ exp: now() - 10 }));
    const middleware = await loadMiddleware();

    const res = await middleware(
      requestWithSession("/settings/plugins", session(expired, now() - 10))
    );
    expect(res.status).toBe(200);
    expect(calls).toContain("POST /auth/v1/token?grant_type=refresh_token");
    expect(calls).not.toContain("GET /auth/v1/user");
    const cookie = res.cookies.get(cookieName)?.value ?? "";
    expect(cookie.startsWith("base64-")).toBe(true);
    const stored = JSON.parse(Buffer.from(cookie.slice("base64-".length), "base64url").toString());
    expect(stored.access_token).not.toBe(expired);
    expect(stored.refresh_token).toBe("refresh-1");
  });

  it("refuses an expired token whose refresh Auth refuses", async () => {
    refreshEndpoint = "refuses";
    const expired = await es256Token(claims({ exp: now() - 10 }));
    const middleware = await loadMiddleware();

    const res = await middleware(requestWithSession("/api/communities", session(expired, now() - 10)));
    expect(res.status).toBe(401);
  });

  it.each([
    [
      "a payload changed after signing",
      async () => {
        const [header, , signature] = (await es256Token(claims())).split(".");
        return `${header}.${encode(claims({ sub: "someone-else" }))}.${signature}`;
      },
    ],
    ["a signature from another key under the project's key id", () => es256Token(claims(), { key: otherKey })],
  ])("refuses %s without asking Auth", async (_label, makeToken) => {
    const token = await makeToken();
    const middleware = await loadMiddleware();

    const res = await middleware(requestWithSession("/api/communities", session(token)));
    expect(res.status).toBe(401);
    expect(calls).not.toContain("GET /auth/v1/user");
  });

  it.each([
    [
      "an RS256 header on the project's EC key",
      () => es256Token(claims(), { header: { alg: "RS256", kid: publicJwk.kid, typ: "JWT" } }),
    ],
    [
      "no exp claim",
      () => {
        const withoutExp: Record<string, unknown> = claims();
        delete withoutExp.exp;
        return es256Token(withoutExp);
      },
    ],
  ])("treats a token with %s as signed out", async (_label, makeToken) => {
    const token = await makeToken();
    const middleware = await loadMiddleware();

    const res = await middleware(requestWithSession("/api/communities", session(token)));
    expect(res.status).toBe(401);
  });

  it("asks Auth about a token signed with a key it does not know", async () => {
    const token = await es256Token(claims(), {
      key: otherKey,
      header: { alg: "ES256", kid: "unknown-key", typ: "JWT" },
    });
    const middleware = await loadMiddleware();

    userEndpoint = "revoked";
    const refused = await middleware(requestWithSession("/api/communities", session(token)));
    expect(refused.status).toBe(401);
    expect(calls).toEqual(["GET /auth/v1/.well-known/jwks.json", "GET /auth/v1/user"]);

    userEndpoint = "live";
    const accepted = await middleware(requestWithSession("/api/communities", session(token)));
    expect(accepted.status).toBe(200);
  });

  it("falls back to Auth for a shared-secret (HS256) token", async () => {
    const middleware = await loadMiddleware();

    const res = await middleware(
      requestWithSession("/settings/plugins", session(hs256Token(claims())))
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(["GET /auth/v1/user"]);
  });
});
