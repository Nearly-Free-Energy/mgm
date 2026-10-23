/**
 * dek-bootstrap.test.ts — a new database does not install without a
 * credential encryption key (docs/runbooks/dek.md § "Create the key").
 *
 * Runs `supabase db reset` against the local stack twice:
 *   1. Without the development opt-in, migration 00018 must stop the reset
 *      with its own error (SQLSTATE 55000), which points at the runbook.
 *   2. With MGM_ALLOW_DEV_CREDENTIAL_KEY=1, the reset must succeed and leave a
 *      key the encryption functions can use. The encrypt/decrypt roundtrip is
 *      the check: the server's WARNING about the throwaway key is not
 *      asserted, because not every Supabase CLI version prints server notices.
 *
 * Each reset wipes the local database, so the suite runs only with
 * RUN_DEK_BOOTSTRAP_TEST=1 and is reported as skipped otherwise. CI runs it in
 * its own step after `npm test`. It needs Docker, a `supabase` CLI on PATH,
 * and the same environment as the other database suites (rls.helpers.ts). It
 * runs whichever `supabase` comes first on PATH: under `npm test` that is the
 * lockfile-pinned CLI in node_modules/.bin when its install step downloaded
 * the binary, and otherwise a globally installed CLI. To reset a different
 * local project, set SUPABASE_WORKDIR and MGM_TEST_SUPABASE_URL.
 *
 * Requirement: Nearly-Free-Energy/mgm#30 (fresh installs need an
 * operator-supplied key).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { assertEnvironmentReady, serviceClient } from "./rls.helpers";

const RESET_TIMEOUT_MS = 300_000;

/**
 * Runs `supabase db reset` with the development opt-in set or cleared. An
 * empty value also stops the CLI loading the variable from a .env file,
 * which it reads for every command.
 */
function dbReset(allowDevKey: boolean): { ok: boolean; output: string } {
  const result = spawnSync("supabase", ["db", "reset", "--yes"], {
    encoding: "utf8",
    env: { ...process.env, MGM_ALLOW_DEV_CREDENTIAL_KEY: allowDevKey ? "1" : "" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: RESET_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

/** The migration the CLI was applying last, which is the one that stopped a failed reset. */
function lastMigration(output: string): string | undefined {
  return [...output.matchAll(/Applying migration (\S+)\.\.\./g)].at(-1)?.[1];
}

/** Retries `call` until it succeeds: PostgREST reconnects to the recreated database on its own. */
async function eventually<T>(
  call: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data, error } = await call();
    if (!error && data !== null) return data;
    if (Date.now() > deadline) {
      throw new Error(`still failing after ${timeoutMs} ms: ${error?.message ?? "no data"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

describe.skipIf(process.env.RUN_DEK_BOOTSTRAP_TEST !== "1")(
  "a fresh database needs a credential encryption key",
  () => {
    beforeAll(async () => {
      await assertEnvironmentReady();
    });

    it("stops at migration 00018 without a key or the development opt-in", () => {
      const reset = dbReset(false);
      expect(reset.ok, reset.output).toBe(false);
      expect(lastMigration(reset.output)).toBe("00018_openems_backend_per_microgrid.sql");
      // The CLI also echoes the failing statement, whose source contains the
      // same words; only the error line has the "ERROR: " prefix and SQLSTATE.
      expect(reset.output).toMatch(
        /ERROR: No credential encryption key\.[^\n]*docs\/runbooks\/dek\.md[^\n]*\(SQLSTATE 55000\)/
      );
    }, RESET_TIMEOUT_MS);

    it("installs with the development opt-in and leaves a usable key", async () => {
      const reset = dbReset(true);
      expect(reset.ok, reset.output).toBe(true);

      const svc = await serviceClient();
      const ciphertext = await eventually(() =>
        svc.rpc("fn_ems_encrypt_secret", { p_plaintext: "probe" })
      );
      const decrypted = await svc.rpc("fn_ems_decrypt_secret", { p_ciphertext: ciphertext });
      expect(decrypted.error).toBeNull();
      expect(decrypted.data).toBe("probe");
    }, RESET_TIMEOUT_MS);
  }
);
