/**
 * GET /api/auth/discovery — what `mgm login --url <site>` needs to sign in to
 * this installation (RFC #259 § 1, #271).
 *
 * Public: the CLI asks before anyone is signed in. Everything in the answer
 * is already public:
 *   - the Supabase URL and anon key, which every page sends to the browser
 *     (ADR-003; getPublicRuntimeConfig, never SUPABASE_INTERNAL_URL);
 *   - Supabase Auth's authorize and token endpoints under that URL;
 *   - the clients' one return address, this site's code page
 *     (docs/setup.md, "Clients that are not a browser");
 *   - the id and kind of each client in mgm_clients, which the CLI puts in
 *     the authorize address anyone can see in the browser. The label and
 *     the dates are not sent.
 * The clients come from mgm_clients itself, read as the service role with
 * those two columns only, so the table the token hook checks is also the
 * one list the CLI is given. The read writes nothing and decrypts nothing.
 * A burst from one address is refused before the read.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getPublicRuntimeConfig } from "@/lib/config/public-runtime-config";
import { appUrl } from "@/lib/config/app-url";
import { checkRateLimit } from "@/lib/rate-limit/in-memory";
import { requestIp } from "@/lib/auth/sign-in-link";
import { CODE_PATH } from "@/lib/auth/client-consent";

const NO_STORE = { "Cache-Control": "no-store" };

type DiscoveryAnswer = {
  supabase_url: string;
  supabase_anon_key: string;
  authorize_url: string;
  token_url: string;
  redirect_uri: string;
  clients: { client_id: string; kind: "operator" | "agent" }[];
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const burst = checkRateLimit(`auth-discovery:${requestIp(request.headers) ?? "unknown"}`, 60, 60_000);
  if (!burst.ok) {
    return NextResponse.json(
      { error: "Too many requests. Wait a minute and try again." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(burst.retryAfter ?? 60) } }
    );
  }

  const config = getPublicRuntimeConfig();
  const { data, error } = await createServiceClient()
    .from("mgm_clients")
    .select("client_id, kind")
    .order("created_at", { ascending: true });
  if (error) {
    console.error(JSON.stringify({ event: "auth.discovery", outcome: "error", error: error.message }));
    return NextResponse.json({ error: "MGM could not list its apps. Try again." }, { status: 500, headers: NO_STORE });
  }

  const auth = `${config.supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
  const body: DiscoveryAnswer = {
    supabase_url: config.supabaseUrl,
    supabase_anon_key: config.supabaseAnonKey,
    authorize_url: `${auth}/oauth/authorize`,
    token_url: `${auth}/oauth/token`,
    redirect_uri: appUrl(CODE_PATH),
    clients: (data ?? []).map((row) => ({ client_id: row.client_id, kind: row.kind })),
  };
  return NextResponse.json(body, { headers: NO_STORE });
}
