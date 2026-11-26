/**
 * What the consent page does when the person clicks Connect, in order
 * (ADR-008 decisions 2 and 3):
 *
 *   1. Record the approval through MGM's server (POST /api/auth/oauth/approvals),
 *      which checks the cookie session with getUser() first. Nothing has asked
 *      Supabase Auth about the sign-in yet, so a refusal here leaves no code
 *      anywhere.
 *   2. Ask Supabase Auth about the authorization with the person's session.
 *      For a client the person approved before, Supabase Auth approves on this
 *      call and answers with the code page's address; otherwise it answers
 *      with the details, and the page approves.
 *   3. Follow the answer only to this site's code page.
 *
 * Its own module, with the network calls passed in, so the page's tests and
 * the sign-in test in the Test gate run exactly this sequence.
 */
import type { AuthOAuthServerApi } from "@supabase/supabase-js";
import { APPROVALS_ROUTE, isCodePageUrl } from "@/lib/auth/client-consent";

export type ApproveDeps = {
  /** POSTs to the approvals route; `fetch` in the browser. */
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** supabase.auth.oauth, signed in with the person's browser session. */
  oauth: Pick<AuthOAuthServerApi, "getAuthorizationDetails" | "approveAuthorization">;
  /** window.location.origin in the browser. */
  siteOrigin: string;
};

export type ApproveResult = { ok: true; redirectUrl: string } | { ok: false; message: string };

const NOT_FINISHED = "MGM could not finish connecting the app. Run mgm login again.";

export async function approveSignIn(authorizationId: string, deps: ApproveDeps): Promise<ApproveResult> {
  let recorded: Response;
  try {
    recorded = await deps.fetch(APPROVALS_ROUTE, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization_id: authorizationId }),
    });
  } catch {
    return { ok: false, message: "MGM could not be reached. Check the connection and try again." };
  }
  const body = (await recorded.json().catch(() => null)) as { client_id?: unknown; error?: unknown } | null;
  if (recorded.status !== 201 || typeof body?.client_id !== "string") {
    return { ok: false, message: typeof body?.error === "string" ? body.error : NOT_FINISHED };
  }

  const details = await deps.oauth.getAuthorizationDetails(authorizationId);
  if (details.error || !details.data) return { ok: false, message: NOT_FINISHED };

  let redirectUrl: string;
  if ("authorization_id" in details.data) {
    // The client Supabase Auth asks about must be the one MGM recorded.
    if (details.data.client.id !== body.client_id) return { ok: false, message: NOT_FINISHED };
    const approved = await deps.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true });
    if (approved.error || !approved.data) return { ok: false, message: NOT_FINISHED };
    redirectUrl = approved.data.redirect_url;
  } else {
    redirectUrl = details.data.redirect_url;
  }

  if (!isCodePageUrl(redirectUrl, deps.siteOrigin)) {
    return { ok: false, message: "MGM stopped: this sign-in returns to an address other than this site." };
  }
  return { ok: true, redirectUrl };
}
