/**
 * The installation's public discovery answer (GET /api/auth/discovery, #271):
 * its Supabase URL and anon key, Supabase Auth's authorize and token
 * endpoints, the code page the clients return to, and the clients it lists.
 */
import type { ClientKind, DiscoveryAnswer } from "../../../src/lib/auth/discovery-answer.ts";
import { CliError } from "./errors.ts";
import { type Fetch, readJson, readRefusal, send, usableUrl } from "./http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The installation's origin from what the person typed after `--url`: a
 * scheme is optional (https is assumed), and any path is dropped. Only https,
 * or http on this computer, is accepted.
 */
export function installationOrigin(typed: string): string {
  const value = typed.trim();
  const url = usableUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (!url) {
    throw new CliError(
      "bad_url",
      `${JSON.stringify(typed)} is not an MGM address mgm can use. Give the address you open MGM at, such as https://mgm.example.org (http only for an installation on this computer).`,
      2,
    );
  }
  return url.origin;
}

function invalid(origin: string, what: string): CliError {
  return new CliError("bad_discovery", `${origin} gave a sign-in answer mgm cannot use (${what}). Is this an MGM address?`);
}

/** How many redirects the discovery request follows, as an address that redirects to the installation's own. */
export const MAX_DISCOVERY_REDIRECTS = 3;

/**
 * Asks for the discovery answer at `origin`, following redirects by hand: each
 * one must lead to an address the CLI may use (https, or http on this
 * computer), and at most MAX_DISCOVERY_REDIRECTS of them. Answers the
 * response and the origin it came from.
 */
async function discoveryResponse(fetch: Fetch, origin: string): Promise<{ res: Response; from: string }> {
  let url = new URL("/api/auth/discovery", origin);
  for (let hops = 0; ; hops += 1) {
    const res = await send(fetch, url.toString(), { headers: { accept: "application/json" } });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return { res, from: url.origin };
    await res.body?.cancel();
    const location = res.headers.get("location");
    const next = location === null ? null : usableUrl(URL.canParse(location, url.toString()) ? new URL(location, url).toString() : null);
    if (!next) {
      throw new CliError(
        "bad_redirect",
        `${url.origin} redirects the sign-in request to ${location === null ? "nowhere" : JSON.stringify(location)}, an address mgm will not send a sign-in to (https only, or http on this computer).`,
      );
    }
    if (hops + 1 > MAX_DISCOVERY_REDIRECTS) {
      throw new CliError("bad_redirect", `${origin} redirects the sign-in request more than ${MAX_DISCOVERY_REDIRECTS} times.`);
    }
    url = next;
  }
}

/**
 * Reads and checks the discovery answer. Every address in it must be https,
 * or http on this computer, since the CLI sends codes and tokens there. An
 * address that redirects is followed (discoveryResponse), and the answer is
 * used only when it names, as its own code page, the origin it came from:
 * so the installation mgm signs in to is always the one that answered.
 */
export async function fetchDiscovery(fetch: Fetch, origin: string): Promise<DiscoveryAnswer> {
  const { res, from } = await discoveryResponse(fetch, origin);
  if (res.status !== 200) {
    const refusal = await readRefusal(res);
    if (res.status === 404) {
      throw new CliError(
        "not_offered",
        `${origin} does not offer sign-in from the terminal (it answered 404${refusal.error ? `: ${refusal.error}` : ""}). Its MGM release may not include the command line yet.`,
      );
    }
    throw new CliError("discovery_refused", `${origin} refused the sign-in request (${res.status}${refusal.error ? `: ${refusal.error}` : ""}).`);
  }
  const body = await readJson(res);
  if (!body) throw invalid(origin, "not JSON");
  for (const key of ["supabase_url", "authorize_url", "token_url", "redirect_uri"] as const) {
    if (!usableUrl(body[key])) throw invalid(origin, `${key} is not an https address`);
  }
  const own = new URL(body.redirect_uri as string).origin;
  if (own !== from) {
    throw new CliError(
      "bad_discovery",
      `${from} answered the sign-in request${from === origin ? "" : ` for ${origin}`} on behalf of ${own}, so mgm will not use it. Give the address you open MGM at.`,
    );
  }
  if (typeof body.supabase_anon_key !== "string" || body.supabase_anon_key === "") throw invalid(origin, "no anon key");
  if (!Array.isArray(body.clients)) throw invalid(origin, "no client list");
  const clients: { client_id: string; kind: ClientKind }[] = [];
  for (const entry of body.clients as unknown[]) {
    const row = entry as Record<string, unknown> | null;
    if (typeof row?.client_id !== "string" || !UUID.test(row.client_id)) throw invalid(origin, "a client id that is not a uuid");
    if (row.kind !== "operator" && row.kind !== "agent") throw invalid(origin, "a client of an unknown kind");
    clients.push({ client_id: row.client_id.toLowerCase(), kind: row.kind });
  }
  return {
    supabase_url: body.supabase_url as string,
    supabase_anon_key: body.supabase_anon_key,
    authorize_url: body.authorize_url as string,
    token_url: body.token_url as string,
    redirect_uri: body.redirect_uri as string,
    clients,
  };
}

/**
 * The operator client the CLI signs in as: the last one listed. Discovery
 * lists clients oldest first, and an installation replacing its CLI client
 * lists the new one before it removes the old.
 */
export function operatorClient(answer: DiscoveryAnswer, origin: string): string {
  const operators = answer.clients.filter((client) => client.kind === "operator");
  if (operators.length === 0) {
    throw new CliError(
      "no_operator_client",
      `${origin} lists no app for the command line. Ask its administrator to register one (docs/setup.md, "Clients that are not a browser").`,
    );
  }
  return operators[operators.length - 1].client_id;
}

/**
 * The installation's own address: the origin of the code page it returns
 * clients to, which is its MGM_APP_URL. An alias that redirects there shares
 * one sign-in with it.
 */
export function canonicalOrigin(answer: DiscoveryAnswer): string {
  return new URL(answer.redirect_uri).origin;
}
