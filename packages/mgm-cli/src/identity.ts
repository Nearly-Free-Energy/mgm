/**
 * Who the token is signed in as, so the CLI can say it, and the
 * installation's contract version, which it compares with its own
 * (RFC #259 decision 10).
 */
import { GUI_CONTRACT } from "../../../src/lib/gui/contract.ts";
import { Unreachable } from "./errors.ts";
import { type Fetch, readJson, send } from "./http.ts";
import { claimsOf } from "./oauth.ts";
import type { TokenFile } from "./store.ts";

/** The contract version this mgm was built with. */
export const CLI_CONTRACT: string = GUI_CONTRACT;

export type Identity = {
  userId: string;
  email: string | null;
  /** The client kind the token carries (`mgm_client_kind`), or the file's when the token carries none. */
  kind: string;
  /** The installation's contract version, or null when its manifest did not answer. */
  contract: string | null;
  /** Where the email came from. */
  source: "manifest" | "auth";
};

/**
 * Asks the installation's manifest (GET /api/gui/manifest), MGM's own answer
 * about the signed-in person, which also carries its contract version. When
 * the manifest does not answer, as while the installation's release does not
 * include it, asks Supabase Auth for the token's user (GET /user) instead,
 * and the contract is not known.
 *
 * GET /user answers a client's token on Supabase Auth v2.198.0 as a stated
 * temporary exception (src/lib/runtime/bearer.ts). If it stops, switch this
 * to GET /oauth/userinfo with the resolver.
 *
 * Throws Unreachable when neither answers, and returns null when Supabase
 * Auth refuses the token (the session has ended).
 */
export async function whoIs(fetch: Fetch, file: TokenFile): Promise<Identity | null> {
  const claims = claimsOf(file.access_token) ?? {};
  const kind = typeof claims.mgm_client_kind === "string" ? claims.mgm_client_kind : file.kind;
  const bearer = { authorization: `Bearer ${file.access_token}`, accept: "application/json" };

  try {
    const res = await send(fetch, `${file.installation}/api/gui/manifest`, { headers: bearer });
    if (res.status === 200) {
      const body = await readJson(res);
      const user = body?.user as { email?: unknown } | undefined;
      if (body?.type === "manifest" && typeof body.contract === "string" && typeof user?.email === "string") {
        return { userId: String(claims.sub ?? file.user.id), email: user.email, kind, contract: body.contract, source: "manifest" };
      }
    } else {
      await res.body?.cancel();
    }
  } catch (error) {
    if (!(error instanceof Unreachable)) throw error;
  }

  const user = await authUser(fetch, file);
  return user && { userId: user.id, email: user.email, kind, contract: null, source: "auth" };
}

/**
 * Asks Supabase Auth itself for the token's user (GET /user): null when Auth
 * refuses the token (401 or 403: the session has ended), and Unreachable
 * when it gives no answer that says either way. Auth, not MGM, is asked
 * whether a session has ended: MGM answers 401 for every bearer request
 * while it cannot reach Auth (src/lib/runtime/bearer.ts).
 */
export async function authUser(fetch: Fetch, file: TokenFile): Promise<{ id: string; email: string | null } | null> {
  const res = await send(fetch, `${file.supabase_url.replace(/\/+$/, "")}/auth/v1/user`, {
    headers: { authorization: `Bearer ${file.access_token}`, accept: "application/json", apikey: file.anon_key },
  });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    return null;
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Unreachable(`Supabase Auth answered ${res.status}`);
  }
  const user = await readJson(res);
  if (typeof user?.id !== "string") throw new Unreachable("Supabase Auth's answer named no user");
  return { id: user.id, email: typeof user.email === "string" ? user.email : null };
}

/** A sentence about the contracts, when they differ. */
export function contractNote(installation: string | null): string | null {
  if (installation === null || installation === CLI_CONTRACT) return null;
  return `This mgm speaks GUI contract ${CLI_CONTRACT}, and the installation ${installation}. Install the mgm from the installation's release.`;
}

/** The label a client kind is shown with. */
export function kindLabel(kind: string): string {
  if (kind === "operator") return "operator (the MGM command line)";
  if (kind === "agent") return "agent (the assistant bridge)";
  return kind;
}
