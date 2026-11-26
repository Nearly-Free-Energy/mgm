/**
 * JWTs for tests of the resolver, signed with ES256 by a key generated for
 * the test run, whose public half JWKS_BODY publishes as the project's key
 * would be (key id TEST_KID). A test that lets verifyBearer fetch keys
 * answers `/auth/v1/.well-known/jwks.json` with JWKS_BODY (jwksAnswer).
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export const TEST_KID = "test-key";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
export const JWKS_BODY = { keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid: TEST_KID, alg: "ES256", use: "sig" }] };

/** The key-set answer for `url`, or null when `url` is not the key-set path. */
export function jwksAnswer(url: string): Response | null {
  if (!new URL(url).pathname.endsWith("/auth/v1/.well-known/jwks.json")) return null;
  return new Response(JSON.stringify(JWKS_BODY), { status: 200, headers: { "content-type": "application/json" } });
}

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A token signed as `header` says, with `key` (the test key by default). */
export function signedToken(claims: Record<string, unknown>, header: Record<string, unknown> = {}, key: KeyObject = privateKey): string {
  const head = part({ alg: "ES256", typ: "JWT", kid: TEST_KID, ...header });
  const body = part(claims);
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${signature.toString("base64url")}`;
}

export const CLIENT_ID = "e7100000-0000-4000-8fff-0000000000c1";
export const USER_ID = "e7100000-0000-4000-8fff-000000000001";

/** A token signed with the test key: what Supabase Auth would issue. */
export function tokenWith(claims: Record<string, unknown>): string {
  return signedToken(claims);
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
