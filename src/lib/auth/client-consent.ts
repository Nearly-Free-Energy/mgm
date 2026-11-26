/**
 * MGM's consent for clients that are not a browser (RFC #259 § 1, ADR-008
 * decisions 2 and 3): the paths, the words for each kind of client, and the
 * two database calls behind the consent page.
 *
 * The calls take the service-role client from their caller, which must have
 * checked the person's cookie session with getUser() first and pass that
 * user's id: fn_client_authorization_read and fn_client_approval_record
 * (20261126150000) run for service_role only. This module imports no
 * client itself, so importing it reaches nothing privileged
 * (service-role-session-check.test.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Where Supabase Auth sends the person (supabase/config.toml, authorization_url_path). */
export const CONSENT_PATH = "/oauth/consent";
/** The clients' one registered return address under the site (docs/setup.md). */
export const CODE_PATH = "/oauth/code";
/** The route the consent page records an approval through. */
export const APPROVALS_ROUTE = "/api/auth/oauth/approvals";

/**
 * Supabase Auth v2.198.0 makes an authorization id of 32 letters and digits
 * (crypto.SecureAlphanumeric). The bounds are looser, so a longer id from a
 * later version still reaches the database, which decides.
 */
const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9]{16,128}$/;

export function isAuthorizationId(value: unknown): value is string {
  return typeof value === "string" && AUTHORIZATION_ID_PATTERN.test(value);
}

export type ClientKind = "operator" | "agent";

export type ConsentClient = { id: string; kind: ClientKind; label: string };

export type ConsentOutcome = "ok" | "unknown" | "expired" | "answered" | "unlisted";

export type ConsentRead =
  | { outcome: "ok"; client: ConsentClient }
  | { outcome: Exclude<ConsentOutcome, "ok"> };

/**
 * What each kind of client is, and what it may do once connected. An
 * operator client's token is the person's own (ADR-008 decision 1). An agent
 * client's token runs as mgm_agent, which the token hook sets
 * (20261126160100); the role reads only what migrations grant it and writes
 * no table the database API serves (decision 7, pinned by
 * agent_role.test.ts). If the hook stops setting the role or the role is
 * granted a write, revisit this text.
 */
export const CLIENT_KINDS: Record<ClientKind, { name: string; may: string }> = {
  operator: {
    name: "Command line",
    may: "It can see and change everything you can in MGM, with your access.",
  },
  agent: {
    name: "Assistant",
    may: "It can read the views MGM offers to assistants, with your access, and cannot change anything.",
  },
};

/** Said about an agent client, whose reads leave MGM (ADR-007, ADR-008 decision 3). */
export const AGENT_PROVIDER_NOTICE =
  "What the assistant reads in MGM goes to the company that runs the assistant.";

/** Why the consent page or the approvals route refuses, by outcome. */
export const CONSENT_PROBLEMS: Record<Exclude<ConsentOutcome, "ok">, { status: number; message: string }> = {
  unknown: {
    status: 404,
    message: "MGM could not find this sign-in for your account. Run mgm login again.",
  },
  expired: {
    status: 410,
    message: "This sign-in has expired. Run mgm login again.",
  },
  answered: {
    status: 409,
    message: "This sign-in has already been answered. Run mgm login again for a new one.",
  },
  unlisted: {
    status: 403,
    message: "MGM does not accept this app.",
  },
};

type Row = { outcome: string; client_id: string | null; kind: string | null; label: string | null };

function toRead(rows: Row[] | null): ConsentRead {
  const row = rows?.[0];
  if (row?.outcome === "ok" && row.client_id && (row.kind === "operator" || row.kind === "agent") && row.label) {
    return { outcome: "ok", client: { id: row.client_id, kind: row.kind, label: row.label } };
  }
  if (row && row.outcome !== "ok" && Object.hasOwn(CONSENT_PROBLEMS, row.outcome)) {
    return { outcome: row.outcome as Exclude<ConsentOutcome, "ok"> };
  }
  throw new Error(`Unexpected consent answer: ${row?.outcome ?? "none"}`);
}

/** The client of a pending sign-in, for the person `userId`. Writes nothing. */
export async function readClientAuthorization(
  service: SupabaseClient,
  authorizationId: string,
  userId: string,
): Promise<ConsentRead> {
  const { data, error } = await service.rpc("fn_client_authorization_read", {
    _authorization_id: authorizationId,
    _user_id: userId,
  });
  if (error) throw new Error(`fn_client_authorization_read: ${error.message}`);
  return toRead(data as Row[] | null);
}

/** Records `userId`'s approval of the sign-in, once per authorization. */
export async function recordClientApproval(
  service: SupabaseClient,
  authorizationId: string,
  userId: string,
): Promise<ConsentRead> {
  const { data, error } = await service.rpc("fn_client_approval_record", {
    _authorization_id: authorizationId,
    _user_id: userId,
  });
  if (error) throw new Error(`fn_client_approval_record: ${error.message}`);
  return toRead(data as Row[] | null);
}

/**
 * True when `redirectUrl`, which Supabase Auth answered the approval with,
 * is this site's code page. The consent page follows nothing else: the
 * clients are registered with that one address (docs/setup.md), so anything
 * else is not one of MGM's clients.
 */
export function isCodePageUrl(redirectUrl: string, siteOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    return false;
  }
  return url.origin === siteOrigin && url.pathname === CODE_PATH;
}
