/**
 * rls.helpers.ts
 *
 * Shared utilities for the RLS test harness.
 *
 * Design:
 *   - JWTs are minted locally with `jose` + SUPABASE_JWT_SECRET — fast, offline, no GoTrue dependency.
 *   - Service-role client is used for all fixture setup (bypasses RLS).
 *   - `clientAs(jwt)` returns an anon-key client with a custom Authorization header,
 *     which is how Supabase RLS evaluates auth.uid() in impersonation tests.
 *
 * Required env vars (set in .env.local):
 *   SUPABASE_JWT_SECRET              — local Supabase JWT signing secret
 *   MGM_PUBLIC_SUPABASE_ANON_KEY     — local anon/publishable key (for non-service-role clients);
 *                                      CI exports it too (.github/workflows/test.yml)
 *
 * The LOCAL_SUPABASE_URL is always http://localhost:54321 — RLS tests never run against cloud.
 * A local service-role JWT is derived at runtime from SUPABASE_JWT_SECRET.
 *
 * Role strings use inline literals (not imported from src/lib/roles.ts) because ticket C
 * (#51) may not have shipped yet. When C lands, replace literals with imports.
 */

import { spawnSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { isPeriodKeptError } from "@/lib/billing/period-delete";

// ── Constants ─────────────────────────────────────────────────────────────

// RLS tests always target local Supabase — never cloud.
const configuredTestUrl = process.env.MGM_TEST_SUPABASE_URL ?? "http://localhost:54321";
const parsedTestUrl = new URL(configuredTestUrl);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedTestUrl.hostname) || parsedTestUrl.protocol !== 'http:') {
  throw new Error("MGM_TEST_SUPABASE_URL must be an HTTP loopback service; cloud databases are forbidden in tests.");
}
export const LOCAL_SUPABASE_URL = configuredTestUrl;

// ── Environment guard ────────────────────────────────────────────────────

/**
 * The local anon/publishable key for tests: MGM_PUBLIC_SUPABASE_ANON_KEY,
 * which setup.sh writes to .env.local and CI exports (test.yml). The retired
 * NEXT_PUBLIC_SUPABASE_ANON_KEY is not read (#79).
 */
export function testAnonKey(): string | undefined {
  return process.env.MGM_PUBLIC_SUPABASE_ANON_KEY?.trim() || undefined;
}

export function shouldSkip(): boolean {
  return process.env.SKIP_RLS_TESTS === "1";
}

/**
 * Validates that the required environment variables are set and that the local
 * Supabase instance is reachable. Throws with an actionable message if not.
 *
 * Call once in beforeAll at the top of the test file.
 */
export async function assertEnvironmentReady(): Promise<void> {
  if (shouldSkip()) {
    return; // Explicit opt-out — skip cleanly without erroring.
  }

  const missing: string[] = [];
  if (!process.env.SUPABASE_JWT_SECRET) missing.push("SUPABASE_JWT_SECRET");
  if (!testAnonKey()) missing.push("MGM_PUBLIC_SUPABASE_ANON_KEY");

  if (missing.length > 0) {
    throw new Error(
      `[RLS tests] Missing required environment variables: ${missing.join(", ")}.\n` +
        "These tests require a running local Supabase CLI instance.\n" +
        "Run ./setup.sh to set up your local environment.\n" +
        "Retrieve SUPABASE_JWT_SECRET with: supabase status | grep 'JWT secret'\n" +
        "Set SKIP_RLS_TESTS=1 to bypass this check (CI without local Supabase)."
    );
  }

  // Verify the local Supabase is actually reachable at the Kong port (54321).
  // Reject cloud URLs — RLS tests must not pollute shared dev DBs.
  try {
    const res = await fetch(`${LOCAL_SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: testAnonKey() ?? "",
      },
      signal: AbortSignal.timeout(3000),
    });
    // PostgREST returns 200 or 401 for the root — either confirms reachability.
    if (res.status >= 500) {
      throw new Error(`Unexpected HTTP ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `[RLS tests] Cannot reach local Supabase at ${LOCAL_SUPABASE_URL}.\n` +
        "Start it with: MGM_ALLOW_DEV_CREDENTIAL_KEY=1 supabase start (or ./setup.sh)\n" +
        "Or set SKIP_RLS_TESTS=1 to bypass.\n" +
        `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── JWT minting ───────────────────────────────────────────────────────────

function jwtSecretBytes(): Uint8Array {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("[RLS tests] SUPABASE_JWT_SECRET is not set");
  return new TextEncoder().encode(secret);
}

/**
 * Mints a JWT for an end-user (role='authenticated').
 * Used to impersonate a specific auth.users row in RLS evaluation.
 * Supabase derives auth.uid() from the 'sub' claim.
 */
export async function mintUserJwt(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    iss: `${LOCAL_SUPABASE_URL}/auth/v1`,
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(jwtSecretBytes());
}

/**
 * Mints a service-role JWT from the local JWT secret.
 * Used for fixture setup — bypasses all RLS policies.
 */
async function mintServiceRoleJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role: "service_role",
    iss: "supabase-demo",
    iat: now,
    exp: now + 3600,
  })
    .setProtectedHeader({ alg: "HS256" })
    .sign(jwtSecretBytes());
}

// ── Supabase client factories ─────────────────────────────────────────────

/**
 * Service-role client — bypasses RLS. Used in beforeAll/afterAll for fixture setup.
 * The service-role JWT is derived at runtime from SUPABASE_JWT_SECRET.
 */
export async function serviceClient(): Promise<SupabaseClient> {
  const serviceRoleJwt = await mintServiceRoleJwt();
  return createClient(LOCAL_SUPABASE_URL, serviceRoleJwt, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Returns a Supabase client that uses the given user JWT as the Authorization bearer.
 * The anon key is required by PostgREST as the apikey header; the JWT overrides
 * the role for RLS evaluation (auth.uid() = sub claim from JWT).
 */
export function clientAs(jwt: string): SupabaseClient {
  const anonKey = testAnonKey();
  if (!anonKey) {
    throw new Error("[RLS tests] MGM_PUBLIC_SUPABASE_ANON_KEY is not set");
  }
  return createClient(LOCAL_SUPABASE_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    },
  });
}

// ── Test user / fixture creation ──────────────────────────────────────────

export interface TestUser {
  userId: string;
  jwt: string;
  client: SupabaseClient;
}

/**
 * Seeds an auth.users row + optional user_roles row, then returns a TestUser
 * with a pre-minted JWT and a Supabase client bound to that JWT.
 *
 * Role strings are inline literals (not imported from src/lib/roles.ts) — see module doc.
 * The Supabase admin API assigns a random UUID; we store the actual ID so teardown
 * can reliably delete it.
 */
export async function createTestUser(opts: {
  email: string;
  role: "super_admin" | "org_manager" | null;
  scopeId?: string | null;
  /**
   * Defaults to 'org', which is the only scope type in use. `microgrid` is
   * inert enum residue from #316, removed from the permission model by #321 —
   * the role-aware CHECK on user_roles (migration 00052) pairs it only with
   * `ems_operator`, which nothing grants any more. Do not seed either.
   */
  scopeType?: "org";
  /**
   * Additional role rows to seed for the same user. The one-row-per-user
   * invariant went away with #316 and has not come back: `user_roles` is
   * UNIQUE (user_id, role, scope_type, scope_id), and every RLS helper reads
   * through EXISTS(...), which is multi-row-safe.
   */
  extraRoles?: {
    role: "super_admin" | "org_manager";
    scopeType: "org";
    scopeId: string | null;
  }[];
}): Promise<TestUser> {
  const svc = await serviceClient();

  // Create the auth user. The admin API generates a UUID automatically.
  const { data: created, error: userError } = await svc.auth.admin.createUser({
    email: opts.email,
    password: `test-pw-${Date.now()}`,
    email_confirm: true,
    user_metadata: {},
    app_metadata: {},
  });

  if (userError) {
    throw new Error(
      `[RLS tests] Failed to create auth user ${opts.email}: ${userError.message}`
    );
  }

  if (!created?.user) {
    throw new Error(`[RLS tests] No user returned for ${opts.email}`);
  }

  const userId = created.user.id;

  // Seed user_roles row if a role is provided.
  if (opts.role) {
    const { error: roleError } = await svc.from("user_roles").insert({
      user_id: userId,
      role: opts.role,
      scope_type: opts.scopeType ?? "org",
      scope_id: opts.role === "super_admin" ? null : (opts.scopeId ?? null),
    });
    if (roleError) {
      throw new Error(
        `[RLS tests] Failed to insert user_roles for ${opts.email}: ${roleError.message}`
      );
    }
  }

  for (const extra of opts.extraRoles ?? []) {
    const { error: extraErr } = await svc.from("user_roles").insert({
      user_id: userId,
      role: extra.role,
      scope_type: extra.scopeType,
      scope_id: extra.scopeId,
    });
    if (extraErr) {
      throw new Error(
        `[RLS tests] Failed to insert extra user_roles (${extra.role}@${extra.scopeType}) for ${opts.email}: ${extraErr.message}`
      );
    }
  }

  const jwt = await mintUserJwt(userId);
  return { userId, jwt, client: clientAs(jwt) };
}

/**
 * Removes all test data inserted during the test run.
 * Deletes auth users by email (cascades to user_roles + household_users).
 * Deletes orgs by ID (cascades to communities → microgrids → ... → billing_line_items).
 */
export async function cleanupTestData(opts: {
  orgIds: string[];
  userEmails: string[];
}): Promise<void> {
  const svc = await serviceClient();

  // Delete auth users by email (admin API lookup then delete).
  const { data: userList } = await svc.auth.admin.listUsers({ perPage: 1000 });
  for (const email of opts.userEmails) {
    const user = userList?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (user) {
      await svc.auth.admin.deleteUser(user.id);
    }
  }

  // Delete orgs — cascades to everything underneath. The database refuses
  // to delete an org that still holds closed billing or billing with
  // recorded payments (20261103160000), whoever asks; those are purged as
  // the database owner instead.
  const kept: string[] = [];
  for (const orgId of opts.orgIds) {
    const { error } = await svc.from("organizations").delete().eq("id", orgId);
    if (error && isPeriodKeptError(error)) kept.push(orgId);
  }
  purgeOrganizationsAsOwner(kept);
}

// ── Database-owner access (fixture cleanup) ───────────────────────────────

/**
 * Runs one SQL statement against the local database as its owner
 * (`postgres`), through `supabase db query`. PostgREST never connects as
 * the owner, so this is the only way a suite can do owner-only work: purge
 * fixtures the billing retention guards keep, or check what the guards do
 * to the owner itself. `supabase db query` sends one statement, so several
 * steps go in one `DO` block, which also makes them atomic.
 *
 * Uses whichever `supabase` comes first on PATH (see dek-bootstrap.test.ts)
 * and the local project in the working directory, or SUPABASE_WORKDIR.
 */
export function runAsDatabaseOwner(sql: string): {
  ok: boolean;
  stdout: string;
  output: string;
} {
  const result = spawnSync(
    "supabase",
    ["db", "query", "--local", "--agent=no", "-o", "json", sql],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }
  );
  if (result.error) {
    throw new Error(
      `[RLS tests] Could not run the supabase CLI for owner SQL: ${result.error.message}`
    );
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    output: `${result.stdout}${result.stderr}`,
  };
}

/**
 * The triggers that refuse deleting closed billing or billing with recorded
 * payments, which a purge disables inside its own statement. A purge fails
 * if one of them is renamed or dropped, so update this list in the same
 * commit as the migration that does it.
 */
const BILLING_RETENTION_TRIGGERS: ReadonlyArray<readonly [table: string, trigger: string]> = [
  ["organizations", "trg_billing_kept_before_delete"],
  ["communities", "trg_billing_kept_before_delete"],
  ["microgrids", "trg_billing_kept_before_delete"],
  ["billing_periods", "trg_billing_period_before_delete_guard"],
  ["billing_line_items", "trg_billing_line_item_before_delete_guard"],
];

const FIXTURE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes fixture organizations, with everything that cascades from them,
 * as the database owner with the billing retention triggers disabled. The
 * triggers are disabled and re-enabled inside one statement, so no other
 * session ever sees them off. Also deletes the organizations'
 * payment_merchant_versions rows, whose foreign key does not cascade.
 *
 * Test cleanup only: nothing in the application has, or needs, a way to do this.
 */
export function purgeOrganizationsAsOwner(orgIds: string[]): void {
  if (orgIds.length === 0) return;
  for (const id of orgIds) {
    if (!FIXTURE_UUID_RE.test(id)) {
      throw new Error(`[RLS tests] Not a fixture organization id: ${id}`);
    }
  }
  const ids = `ARRAY[${orgIds.map((id) => `'${id}'`).join(", ")}]::uuid[]`;
  const toggle = (action: "DISABLE" | "ENABLE") =>
    BILLING_RETENTION_TRIGGERS.map(
      ([table, trigger]) => `  ALTER TABLE ${table} ${action} TRIGGER ${trigger};`
    ).join("\n");
  const result = runAsDatabaseOwner(
    [
      "DO $purge$",
      "BEGIN",
      toggle("DISABLE"),
      `  DELETE FROM payment_merchant_versions WHERE org_id = ANY (${ids});`,
      `  DELETE FROM organizations WHERE id = ANY (${ids});`,
      toggle("ENABLE"),
      "END",
      "$purge$",
    ].join("\n")
  );
  if (!result.ok) {
    throw new Error(`[RLS tests] Owner purge of ${orgIds.join(", ")} failed:\n${result.output}`);
  }
}
