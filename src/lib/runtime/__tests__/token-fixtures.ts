/** Unsigned JWT-shaped strings for tests of the resolver: three base64url parts. */
export const CLIENT_ID = "e7100000-0000-4000-8fff-0000000000c1";
export const USER_ID = "e7100000-0000-4000-8fff-000000000001";

export function tokenWith(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "ES256", typ: "JWT", kid: "k" })}.${part(claims)}.c2lnbmF0dXJl`;
}

export const operatorClaims = (over: Record<string, unknown> = {}) => ({
  sub: USER_ID,
  role: "authenticated",
  client_id: CLIENT_ID,
  mgm_client_kind: "operator",
  ...over,
});

export const agentClaims = (over: Record<string, unknown> = {}) =>
  operatorClaims({ role: "mgm_agent", mgm_client_kind: "agent", ...over });

/** A browser session's claims: no client_id, no kind. */
export const browserClaims = (over: Record<string, unknown> = {}) => ({ sub: USER_ID, role: "authenticated", ...over });
