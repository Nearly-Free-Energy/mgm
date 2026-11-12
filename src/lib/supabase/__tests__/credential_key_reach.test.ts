/**
 * credential_key_reach.test.ts — which database functions signed-in and
 * anonymous callers can run that reach the credential key.
 *
 * Every stored credential (OpenEMS and payments) is encrypted with one key,
 * so a SECURITY DEFINER function that decrypts, or reads the key, hands its
 * caller every credential it can name. Grants on these functions have changed
 * between migrations before, so this test reads the catalog of the database
 * the migrations built instead of trusting any one migration:
 *
 *   1. It lists every function in `public` with its body and grants.
 *   2. A function reaches the key if its body calls a decryption primitive
 *      or reads `vault.decrypted_secrets`, or calls a function that does
 *      (followed to a fixed point, by name).
 *   3. Among those, the SECURITY DEFINER functions `authenticated` or `anon`
 *      can EXECUTE must be exactly `ALLOWED` below.
 *
 * Requires a running local Supabase (same harness as rls.test.ts); the
 * catalog is read as the database owner through `supabase db query`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { assertEnvironmentReady, runAsDatabaseOwner, shouldSkip } from "./rls.helpers";

interface CatalogFunction {
  signature: string;
  definer: boolean;
  authenticated: boolean;
  anon: boolean;
  body: string;
}

// fn_ems_encrypt_secret reads the key to encrypt and returns only
// ciphertext; the settings routes encrypt as the caller. If it ever returns
// anything derived from plaintext or the key, or a second entry is needed,
// that is a change to the credential model, not to this list.
const ALLOWED = [{ signature: "fn_ems_encrypt_secret(text)", authenticated: true, anon: false }];

const PRIMITIVE =
  /\bpgp_(?:sym|pub)_decrypt\w*\s*\(|\bdecrypt(?:_iv)?\s*\(|\bdecrypted_secrets\b|\bcrypto_\w*decrypt\w*\s*\(/i;

function bareName(signature: string): string {
  return signature.split("(")[0].split(".").pop() as string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Signatures whose bodies reach the key, directly or through each other. */
function reachingFunctions(functions: CatalogFunction[]): Set<string> {
  const reaching = new Set(functions.filter((f) => PRIMITIVE.test(f.body)).map((f) => f.signature));
  for (;;) {
    const callees = [...reaching].map((s) => new RegExp(`\\b${escapeRegExp(bareName(s))}\\s*\\(`));
    const added = functions.filter(
      (f) => !reaching.has(f.signature) && callees.some((callee) => callee.test(f.body))
    );
    if (added.length === 0) return reaching;
    for (const f of added) reaching.add(f.signature);
  }
}

let functions: CatalogFunction[] = [];

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  const query = runAsDatabaseOwner(
    `SELECT p.oid::regprocedure::text AS signature,
            p.prosecdef AS definer,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            p.prosrc AS body
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      ORDER BY 1`
  );
  if (!query.ok) throw new Error(`[catalog] ${query.output}`);
  functions = JSON.parse(query.stdout) as CatalogFunction[];
});

describe.skipIf(shouldSkip())("functions that reach the credential key", () => {
  it("finds the decrypt helpers, so a miss below is not a blind detector", () => {
    const reaching = reachingFunctions(functions);
    for (const signature of [
      "fn_ems_decrypt_secret(bytea)",
      "fn_get_ems_secret(uuid)",
      "fn_get_payment_merchant_secret(uuid)",
    ]) {
      expect(reaching.has(signature), `${signature} should be detected`).toBe(true);
    }
  });

  it("lets signed-in and anonymous callers run only the encrypt function", () => {
    const reaching = reachingFunctions(functions);
    const exposed = functions
      .filter((f) => reaching.has(f.signature) && f.definer && (f.authenticated || f.anon))
      .map(({ signature, authenticated, anon }) => ({ signature, authenticated, anon }));
    expect(exposed).toEqual(ALLOWED);
  });

  it("follows calls through other functions", () => {
    const reaching = reachingFunctions([
      { signature: "inner(bytea)", definer: true, authenticated: false, anon: false, body: "SELECT pgp_sym_decrypt($1, k)" },
      { signature: "middle(uuid)", definer: true, authenticated: false, anon: false, body: "RETURN inner(x);" },
      { signature: "outer(uuid)", definer: true, authenticated: true, anon: false, body: "RETURN middle (y);" },
      { signature: "unrelated(uuid)", definer: true, authenticated: true, anon: false, body: "RETURN inner_count(z);" },
    ]);
    expect([...reaching].sort()).toEqual(["inner(bytea)", "middle(uuid)", "outer(uuid)"]);
  });
});
