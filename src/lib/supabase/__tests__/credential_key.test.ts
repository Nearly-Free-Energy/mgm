/**
 * credential_key.test.ts — the credential encryption functions after the
 * MGM key-name migration (20261014090000_mgm_credential_key_name.sql).
 *
 * The migration copies the Vault key to `mgm_ems_dek` and re-issues
 * fn_ems_encrypt_secret / fn_ems_decrypt_secret to read it (falling back to
 * the legacy `mbe_ems_dek`). These tests pin what callers depend on:
 *   - a value encrypted by the database decrypts back to itself;
 *   - encrypt stays callable by signed-in users (the Save route encrypts as
 *     the caller) and decrypt stays service-role only;
 *   - anonymous callers can use neither.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "./rls.helpers";
import { createClient } from "@supabase/supabase-js";

const EMAIL = "credential-key-manager@test.local";
const ORG = "eb000000-0000-4000-8000-000000000001";

let manager: TestUser;

function deniedOrMissing(error: { code?: string; message?: string } | null): boolean {
  return (
    error?.code === "42501" ||
    error?.code === "PGRST202" ||
    (error?.message ?? "").toLowerCase().includes("permission denied")
  );
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL] });
  const svc = await serviceClient();
  const { error } = await svc.from("organizations").insert({ id: ORG, name: "Credential Key Org" });
  if (error) throw new Error(`[fixture] org: ${error.message}`);
  manager = await createTestUser({ email: EMAIL, role: "org_manager", scopeId: ORG });
});

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanupTestData({ orgIds: [ORG], userEmails: [EMAIL] });
});

describe.skipIf(shouldSkip())("credential encryption key", () => {
  it("round-trips a value through encrypt and decrypt", async () => {
    const svc = await serviceClient();
    const encrypted = await svc.rpc("fn_ems_encrypt_secret", { p_plaintext: "s3cret-value" });
    expect(encrypted.error).toBeNull();
    expect(typeof encrypted.data).toBe("string");

    const decrypted = await svc.rpc("fn_ems_decrypt_secret", { p_ciphertext: encrypted.data });
    expect(decrypted.error).toBeNull();
    expect(decrypted.data).toBe("s3cret-value");
  });

  it("returns null for null input", async () => {
    const svc = await serviceClient();
    const { data, error } = await svc.rpc("fn_ems_encrypt_secret", { p_plaintext: null });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("lets a signed-in user encrypt but not decrypt", async () => {
    const encrypted = await manager.client.rpc("fn_ems_encrypt_secret", { p_plaintext: "from-ui" });
    expect(encrypted.error).toBeNull();

    const decrypted = await manager.client.rpc("fn_ems_decrypt_secret", {
      p_ciphertext: encrypted.data,
    });
    expect(deniedOrMissing(decrypted.error)).toBe(true);
    expect(decrypted.data).toBeNull();
  });

  it("denies anonymous callers both functions", async () => {
    const anon = createClient(
      process.env.MGM_TEST_SUPABASE_URL ?? "http://localhost:54321",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const encrypted = await anon.rpc("fn_ems_encrypt_secret", { p_plaintext: "x" });
    expect(deniedOrMissing(encrypted.error)).toBe(true);
    const decrypted = await anon.rpc("fn_ems_decrypt_secret", { p_ciphertext: "\\x00" });
    expect(deniedOrMissing(decrypted.error)).toBe(true);
  });
});
