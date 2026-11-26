/**
 * A stand-in installation for the CLI's unit tests: MGM's discovery,
 * manifest and logout routes, and Supabase Auth's token and user endpoints,
 * answered in memory. The real ones are cli.db.test.ts's.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { Deps } from "../commands.ts";
import type { Fetch } from "../http.ts";
import { Store } from "../store.ts";

export const ORIGIN = "https://mgm.example.org";
export const SUPABASE = "https://abc.supabase.co";
export const CLIENT_ID = "0b6c1c9e-5d0a-4c8e-9f63-3c1f0a7d2e41";
export const USER = { id: "6f7c2a1e-1b2c-4d3e-8f90-a1b2c3d4e5f6", email: "person@example.org" };

/** An access token with these claims (unsigned: the stand-ins never check it). */
export function accessToken(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "ES256", typ: "JWT" })}.${part(claims)}.c2ln`;
}

type Json = Record<string, unknown>;

/** The stand-in installation's discovery answer; `redirectUri` names the installation it answers for. */
export function discoveryAnswer(redirectUri = `${ORIGIN}/oauth/code`): Json {
  return {
    supabase_url: SUPABASE,
    supabase_anon_key: "sb_publishable_test",
    authorize_url: `${SUPABASE}/auth/v1/oauth/authorize`,
    token_url: `${SUPABASE}/auth/v1/oauth/token`,
    redirect_uri: redirectUri,
    clients: [
      { client_id: "11111111-2222-4333-8444-555555555555", kind: "operator" },
      { client_id: "99999999-2222-4333-8444-555555555555", kind: "agent" },
      { client_id: CLIENT_ID, kind: "operator" },
    ],
  };
}
export const json = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeInstallation() {
  const state = {
    mgmDown: false,
    /** "ok" answers the manifest; "unreleased" answers 404 in plain text, as an installation whose release lacks it. */
    manifest: "ok" as "ok" | "unreleased",
    contract: "0.2.1",
    logoutStatus: 204,
    logoutBody: "",
    refuseRefresh: false,
    /** Supabase Auth's GET /user refuses the token, as for a session that has ended. */
    authRefusesToken: false,
    /** Other origins the test answers for (an alias, another site), by origin. */
    others: {} as Record<string, (url: URL, init: RequestInit) => Response>,
    userCalls: 0,
    refreshDelayMs: 0,
    refreshCalls: 0,
    logoutCalls: [] as { authorization: string | null; body: string | null }[],
    exchanges: 0,
    /** Authorize addresses the CLI opened. */
    opened: [] as URL[],
    /** Valid refresh token, and the codes issued, keyed by code with their challenge. */
    refreshToken: "",
    codes: new Map<string, string>(),
    sessionId: randomUUID(),
    issued: 0,
  };

  function issue(): Json {
    state.issued += 1;
    state.refreshToken = `refresh-${state.issued}`;
    return {
      access_token: accessToken({
        sub: USER.id,
        email: USER.email,
        role: "authenticated",
        client_id: CLIENT_ID,
        mgm_client_kind: "operator",
        session_id: state.sessionId,
        n: state.issued,
      }),
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: state.refreshToken,
    };
  }

  const fetch: Fetch = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    expect(init.redirect).toBe("manual");
    const other = state.others[url.origin];
    if (other) return other(url, init);
    if (url.origin === ORIGIN) {
      if (state.mgmDown) throw new TypeError("fetch failed");
      if (url.pathname === "/api/auth/discovery") {
        return json(discoveryAnswer());
      }
      if (url.pathname === "/api/gui/manifest") {
        if (state.manifest === "unreleased") return new Response("Not available in this MGM release", { status: 404 });
        return json({ type: "manifest", contract: state.contract, release: null, user: { name: null, email: USER.email } });
      }
      if (url.pathname === "/api/auth/logout" && init.method === "POST") {
        state.logoutCalls.push({ authorization: headers.get("authorization"), body: (init.body as string | undefined) ?? null });
        return new Response(state.logoutBody || null, { status: state.logoutStatus });
      }
      return new Response("Not available in this MGM release", { status: 404 });
    }
    if (url.origin === SUPABASE) {
      if (url.pathname === "/auth/v1/oauth/token") {
        expect(headers.get("apikey")).toBe("sb_publishable_test");
        const form = new URLSearchParams(String(init.body));
        expect(form.get("client_id")).toBe(CLIENT_ID);
        if (form.get("grant_type") === "authorization_code") {
          state.exchanges += 1;
          const challenge = state.codes.get(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          if (!challenge || createHash("sha256").update(verifier).digest("base64url") !== challenge) {
            return json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400);
          }
          state.codes.delete(form.get("code")!);
          return json(issue());
        }
        if (form.get("grant_type") === "refresh_token") {
          state.refreshCalls += 1;
          if (state.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, state.refreshDelayMs));
          if (state.refuseRefresh || form.get("refresh_token") !== state.refreshToken) {
            return json({ error: "invalid_grant", error_description: "Invalid Refresh Token: Already Used" }, 400);
          }
          return json(issue());
        }
      }
      if (url.pathname === "/auth/v1/user") {
        state.userCalls += 1;
        if (state.authRefusesToken) return json({ code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" }, 403);
        return json({ id: USER.id, email: USER.email });
      }
    }
    throw new Error(`[fake installation] unexpected request ${init.method ?? "GET"} ${input}`);
  };

  /** What the browser half does with the address the CLI opened: the code page's string for it. */
  function approve(address: URL = state.opened[state.opened.length - 1]): string {
    const code = randomUUID();
    state.codes.set(code, address.searchParams.get("code_challenge")!);
    return `${address.searchParams.get("state")}.${code}`;
  }

  return { state, fetch, approve };
}

/** A token store in a new temporary directory, and its removal. */
export async function temporaryStore(): Promise<{ store: Store; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mgm-cli-test-"));
  const store = new Store(join(dir, "mgm"), process.getuid?.());
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Command deps against `installation`, with the person pasting what `paste` returns. */
export function depsFor(
  installation: ReturnType<typeof fakeInstallation>,
  store: Store,
  o: { paste?: () => string; now?: () => number; notes?: string[] } = {},
): Deps {
  return {
    fetch: installation.fetch,
    store,
    now: o.now ?? Date.now,
    platform: "linux",
    note: (line) => o.notes?.push(line),
    openBrowser: async (address) => {
      installation.state.opened.push(new URL(address));
      return true;
    },
    prompt: async () => (o.paste ?? (() => installation.approve()))(),
  };
}
