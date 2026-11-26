/**
 * The answer of GET /api/auth/discovery (RFC #259 § 1, #271): what
 * `mgm login --url <site>` needs to sign in to an installation. The route
 * (src/app/api/auth/discovery/route.ts) builds it, and the CLI
 * (packages/mgm-cli) reads it, from this one definition.
 *
 * Types only, importing nothing, so the CLI can share it without the app;
 * the CLI's boundary test (packages/mgm-cli/src/__tests__/boundary.test.ts)
 * holds it to that.
 */

/** A client MGM accepts (mgm_clients.kind): the CLI is an operator client, the assistant bridge an agent client. */
export type ClientKind = "operator" | "agent";

export type DiscoveryAnswer = {
  /** The public Supabase URL, as every page sends it to the browser. */
  supabase_url: string;
  /** The public anon key, sent as `apikey` on Supabase Auth's token endpoint. */
  supabase_anon_key: string;
  /** Supabase Auth's authorize endpoint, opened in the browser. */
  authorize_url: string;
  /** Supabase Auth's token endpoint, for the code exchange and refreshes. */
  token_url: string;
  /** The clients' one return address: this installation's code page (MGM_APP_URL plus /oauth/code). */
  redirect_uri: string;
  /** Every client mgm_clients lists, oldest first. */
  clients: { client_id: string; kind: ClientKind }[];
};
