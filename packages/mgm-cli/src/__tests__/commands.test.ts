/**
 * mgm login, whoami and logout against a stand-in installation
 * (fake-installation.ts): what each writes, says and sends. Against a real
 * installation and Supabase Auth: cli.db.test.ts.
 */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../cli.ts";
import { login, logout, whoami } from "../commands.ts";
import { freshTokenFile } from "../session.ts";
import { type Store, configFilePath, installationKey, tokenFilePath } from "../store.ts";
import { CLIENT_ID, ORIGIN, USER, depsFor, discoveryAnswer, fakeInstallation, json, temporaryStore } from "./fake-installation.ts";

let store: Store;
let cleanup: () => Promise<void>;
let site: ReturnType<typeof fakeInstallation>;
const tokenPath = () => tokenFilePath(store.base, ORIGIN, "operator");

beforeEach(async () => {
  ({ store, cleanup } = await temporaryStore());
  site = fakeInstallation();
});
afterEach(async () => {
  await cleanup();
});

/** Runs `mgm` and collects what it printed. */
async function mgm(argv: string[], deps = depsFor(site, store)) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, deps, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join(""), err: err.join("") };
}

describe("mgm login", () => {
  it("signs in as the last operator client listed, saves the token file and says who it is signed in as", async () => {
    const notes: string[] = [];
    const answer = await login(depsFor(site, store, { notes }), { url: "mgm.example.org" });

    expect(answer).toEqual({
      installation: ORIGIN,
      email: USER.email,
      user_id: USER.id,
      client_id: CLIENT_ID,
      client_kind: "operator",
      token_file: tokenPath(),
      contract: { cli: "0.2.1", installation: "0.2.1" },
      contract_note: null,
    });
    const opened = site.state.opened[0];
    expect(opened.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(opened.searchParams.get("code_challenge_method")).toBe("S256");
    expect(opened.searchParams.get("scope")).toBe("email");
    // The address is printed too, for a terminal with no browser.
    expect(notes).toContain(`  ${opened.toString()}`);

    const file = await store.readToken(tokenPath());
    expect(file).toMatchObject({ installation: ORIGIN, client_id: CLIENT_ID, kind: "operator", user: USER, refresh_token: "refresh-1" });
    expect((await lstat(tokenPath())).mode & 0o777).toBe(0o600);
    expect(await store.currentInstallation()).toBe(ORIGIN);
  });

  it("prints the installation, the person and the client kind, as text and as JSON", async () => {
    const text = await mgm(["login", "--url", ORIGIN]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`Signed in to ${ORIGIN} as ${USER.email}.`);
    expect(text.out).toContain("Client:     operator (the MGM command line)");
    expect(text.out).toContain(`Token file: ${tokenPath()}`);

    const json = await mgm(["login", "--url", ORIGIN, "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ installation: ORIGIN, email: USER.email, client_kind: "operator", token_file: tokenPath() });
  });

  it("refuses a pasted code whose state is not its own, and writes no file", async () => {
    const deps = depsFor(site, store, {
      paste: () => site.approve(new URL(`${site.state.opened[0].toString().replace(/state=[^&]+/, `state=${"z".repeat(43)}`)}`)),
    });
    await expect(login(deps, { url: ORIGIN })).rejects.toMatchObject({ code: "wrong_state" });
    expect(site.state.exchanges).toBe(0);
    await expect(readdir(store.base)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a pasted string that is not a code, and writes no file", async () => {
    const result = await mgm(["login", "--url", ORIGIN], depsFor(site, store, { paste: () => "not-a-code" }));
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not a sign-in code/);
    await expect(readdir(store.base)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses on Windows before asking anything", async () => {
    const deps = { ...depsFor(site, store), platform: "win32" };
    await expect(login(deps, { url: ORIGIN })).rejects.toMatchObject({ code: "unsupported_platform" });
    expect(site.state.opened).toEqual([]);
  });

  it("follows an address that redirects to the installation's own, and keeps its sign-in there", async () => {
    const ALIAS = "https://alias.example.org";
    site.state.others[ALIAS] = (url) => new Response(null, { status: 308, headers: { location: `${ORIGIN}${url.pathname}` } });
    const notes: string[] = [];
    const answer = await login(depsFor(site, store, { notes }), { url: "alias.example.org" });
    expect(answer.installation).toBe(ORIGIN);
    expect(answer.token_file).toBe(tokenPath());
    expect(notes).toContain(`${ALIAS} leads to ${ORIGIN}; signing in there.`);
    // whoami and logout given the alias find the same file.
    expect((await whoami(depsFor(site, store), { url: ALIAS })).installation).toBe(ORIGIN);
    expect(await logout(depsFor(site, store), { url: ALIAS })).toMatchObject({ installation: ORIGIN, session: "ended" });
    expect(await store.readToken(tokenPath())).toBeNull();
  });

  it("finds the installation's file for an alias it was not signed in through", async () => {
    await login(depsFor(site, store), { url: ORIGIN });
    const ALIAS = "https://alias.example.org";
    site.state.others[ALIAS] = (url) => new Response(null, { status: 301, headers: { location: `${ORIGIN}${url.pathname}` } });
    expect((await whoami(depsFor(site, store), { url: ALIAS })).installation).toBe(ORIGIN);
    const result = await mgm(["logout", "--url", ALIAS]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`Signed out of ${ORIGIN}. The token file is deleted.\n`);
    expect(site.state.logoutCalls).toHaveLength(1);
  });

  it("refuses a redirect to an http address on another computer", async () => {
    site.state.others["https://alias.example.org"] = () =>
      new Response(null, { status: 302, headers: { location: "http://mgm.example.org/api/auth/discovery" } });
    await expect(login(depsFor(site, store), { url: "https://alias.example.org" })).rejects.toMatchObject({ code: "bad_redirect" });
    expect(site.state.opened).toEqual([]);
  });

  it("refuses an answer from another origin that names the typed one as its own", async () => {
    const ELSEWHERE = "https://elsewhere.example.net";
    site.state.others["https://alias.example.org"] = () =>
      new Response(null, { status: 307, headers: { location: `${ELSEWHERE}/api/auth/discovery` } });
    site.state.others[ELSEWHERE] = () => json(discoveryAnswer("https://alias.example.org/oauth/code"));
    const result = await mgm(["login", "--url", "https://alias.example.org"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/elsewhere\.example\.net answered the sign-in request for https:\/\/alias\.example\.org on behalf of https:\/\/alias\.example\.org/);
    expect(site.state.opened).toEqual([]);
    // Nor one answering at the typed address for another origin.
    site.state.others[ELSEWHERE] = () => json(discoveryAnswer(`${ORIGIN}/oauth/code`));
    await expect(login(depsFor(site, store), { url: ELSEWHERE })).rejects.toMatchObject({ code: "bad_discovery" });
    expect(site.state.opened).toEqual([]);
  });

  it("stops after a few redirects", async () => {
    site.state.others["https://loop.example.org"] = (url) => new Response(null, { status: 302, headers: { location: url.toString() } });
    await expect(login(depsFor(site, store), { url: "https://loop.example.org" })).rejects.toMatchObject({ code: "bad_redirect" });
  });

  it("ends the session a second login replaces", async () => {
    await login(depsFor(site, store), { url: ORIGIN });
    const first = await store.readToken(tokenPath());
    const notes: string[] = [];
    await login(depsFor(site, store, { notes }), { url: ORIGIN });
    expect(site.state.logoutCalls).toHaveLength(1);
    expect(site.state.logoutCalls[0].authorization).toBe(`Bearer ${first?.access_token}`);
    expect(notes).toContain(`This terminal's earlier sign-in to ${ORIGIN} is ended.`);
    expect((await store.readToken(tokenPath()))?.refresh_token).toBe("refresh-2");

    // When MGM cannot end it, it says so.
    site.state.logoutStatus = 404;
    const later: string[] = [];
    await login(depsFor(site, store, { notes: later }), { url: ORIGIN });
    expect(later.join("\n")).toMatch(/earlier sign-in .* was replaced and may still be live[\s\S]*Connected apps/);
  });

  it("says when the installation's release does not offer it", async () => {
    const result = await mgm(["login", "--url", "https://other.example.org"], {
      ...depsFor(site, store),
      fetch: async () => new Response("Not available in this MGM release", { status: 404 }),
    });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/does not offer sign-in from the terminal.*Not available in this MGM release/);
  });
});

describe("mgm whoami", () => {
  beforeEach(async () => {
    await login(depsFor(site, store), { url: ORIGIN });
  });

  it("names the installation, the person, the client kind and the token file", async () => {
    const result = await mgm(["whoami"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      [
        `Signed in to ${ORIGIN} as ${USER.email}.`,
        "Client:     operator (the MGM command line)",
        `Token file: ${tokenPath()} (readable only by you)`,
        "Contract:   0.2.1 (this mgm), 0.2.1 (installation)",
        "",
      ].join("\n"),
    );
    expect(JSON.parse((await mgm(["whoami", "--json"])).out)).toEqual({
      installation: ORIGIN,
      email: USER.email,
      user_id: USER.id,
      client_id: CLIENT_ID,
      client_kind: "operator",
      token_file: tokenPath(),
      contract: { cli: "0.2.1", installation: "0.2.1" },
      contract_note: null,
    });
  });

  it("says so when the installation's contract differs from its own", async () => {
    site.state.contract = "0.3.0";
    const result = await mgm(["whoami"]);
    expect(result.out).toContain("This mgm speaks GUI contract 0.2.1, and the installation 0.3.0.");
  });

  it("asks Supabase Auth who it is while the installation's release has no manifest", async () => {
    site.state.manifest = "unreleased";
    const answer = await whoami(depsFor(site, store), {});
    expect(answer).toMatchObject({ email: USER.email, client_kind: "operator", contract: { cli: "0.2.1", installation: null }, contract_note: null });
  });

  it("refreshes an expiring token first, and says to sign in again when the refresh is refused", async () => {
    const later = () => Date.now() + 3_590_000;
    await whoami(depsFor(site, store, { now: later }), {});
    expect(site.state.refreshCalls).toBe(1);
    expect((await store.readToken(tokenPath()))?.refresh_token).toBe("refresh-2");

    site.state.refuseRefresh = true;
    const result = await mgm(["whoami"], depsFor(site, store, { now: () => Date.now() + 7_200_000 }));
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/Your sign-in to https:\/\/mgm\.example\.org has ended .*Run: mgm login --url https:\/\/mgm\.example\.org/);
  });

  it("says when this terminal is not signed in to an installation", async () => {
    const result = await mgm(["whoami", "--url", "https://other.example.org"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not signed in to https:\/\/other\.example\.org/);
  });
});

describe("two commands refreshing at once", () => {
  it("send one refresh, and both go on signed in", async () => {
    await login(depsFor(site, store), { url: ORIGIN });
    site.state.refreshDelayMs = 150;
    const deps = depsFor(site, store, { now: () => Date.now() + 3_590_000 });
    const [a, b] = await Promise.all([freshTokenFile(deps, tokenPath(), ORIGIN), freshTokenFile(deps, tokenPath(), ORIGIN)]);
    expect(site.state.refreshCalls).toBe(1);
    expect(a.refresh_token).toBe("refresh-2");
    expect(b.refresh_token).toBe("refresh-2");
    expect((await store.readToken(tokenPath()))?.refresh_token).toBe("refresh-2");
    expect(await readdir(join(store.base, "installations", installationKey(ORIGIN)))).toEqual(["operator.json"]);
  });
});

describe("mgm logout", () => {
  beforeEach(async () => {
    await login(depsFor(site, store), { url: ORIGIN });
  });

  it("asks MGM to end the session with its own token, then deletes the token file", async () => {
    const result = await mgm(["logout"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`Signed out of ${ORIGIN}. The token file is deleted.\n`);
    expect(site.state.logoutCalls).toHaveLength(1);
    const token = (site.state.logoutCalls[0].authorization ?? "").replace(/^Bearer /, "");
    expect(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).session_id).toBe(site.state.sessionId);
    expect(site.state.logoutCalls[0].body).toBeNull();
    expect(await store.readToken(tokenPath())).toBeNull();
    // The current installation stays, so `mgm login` signs in there again.
    expect(await store.currentInstallation()).toBe(ORIGIN);
    expect((await lstat(configFilePath(store.base))).isFile()).toBe(true);
  });

  it("deletes the file and says to revoke the app from Connected apps when MGM cannot be reached", async () => {
    site.state.mgmDown = true;
    const result = await mgm(["logout", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ installation: ORIGIN, session: "not_confirmed", advice: expect.stringContaining("Connected apps") });
    expect(await store.readToken(tokenPath())).toBeNull();
  });

  it.each([
    [404, "Not available in this MGM release"],
    [403, JSON.stringify({ error: "This installation does not accept app tokens right now.", code: "client_tokens_off" })],
  ])("deletes the file and gives the same advice when MGM answers %i", async (status, body) => {
    site.state.logoutStatus = status;
    site.state.logoutBody = body;
    const result = await mgm(["logout"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/may still be signed in[\s\S]*Connected apps/);
    expect(await store.readToken(tokenPath())).toBeNull();
  });

  it("treats a session MGM and Supabase Auth both refuse, or a refresh refused, as already ended", async () => {
    site.state.logoutStatus = 401;
    site.state.authRefusesToken = true;
    expect(await logout(depsFor(site, store), {})).toMatchObject({ session: "already_ended", advice: null });
    expect(site.state.userCalls).toBe(1);
    expect(await store.readToken(tokenPath())).toBeNull();
    site.state.authRefusesToken = false;

    await login(depsFor(site, store), { url: ORIGIN });
    site.state.refuseRefresh = true;
    expect(await logout(depsFor(site, store, { now: () => Date.now() + 7_200_000 }), {})).toMatchObject({ session: "already_ended" });
    expect(await store.readToken(tokenPath())).toBeNull();
  });

  it("does not take MGM's 401 as the end of a session Supabase Auth still accepts", async () => {
    site.state.logoutStatus = 401;
    site.state.logoutBody = JSON.stringify({ error: "Authentication required", code: "unauthenticated" });
    const result = await mgm(["logout", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      session: "not_confirmed",
      advice: expect.stringMatching(/Supabase Auth still does[\s\S]*Connected apps/),
    });
    expect(site.state.userCalls).toBeGreaterThan(0);
    expect(await store.readToken(tokenPath())).toBeNull();
  });

  it("sends the token only to the installation its file names", async () => {
    const stored = await store.readToken(tokenPath());
    await store.writeToken(tokenPath(), { ...stored!, installation: "https://elsewhere.example.net" });
    await expect(logout(depsFor(site, store), {})).rejects.toMatchObject({ code: "bad_token_file" });
    expect(site.state.logoutCalls).toEqual([]);
  });

  it("answers plainly when there is nothing to sign out of", async () => {
    await logout(depsFor(site, store), {});
    const result = await mgm(["logout"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`Not signed in to ${ORIGIN}.\n`);
  });
});

describe("the command line", () => {
  it("prints help, and refuses an unknown command or option", async () => {
    expect((await mgm(["--help"])).out).toMatch(/^Usage: mgm <command>/);
    expect((await mgm(["admin"])).code).toBe(2);
    expect((await mgm(["login", "--password", "x"])).code).toBe(2);
  });
});
