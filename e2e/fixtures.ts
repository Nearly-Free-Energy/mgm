import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  cleanupTestData,
  createTestUser,
  LOCAL_SUPABASE_URL,
  serviceClient,
} from "../src/lib/supabase/__tests__/rls.helpers";

// The smoke's own rows: one organization, one community with an invoice
// configuration whose logo is an object in the invoice-logos bucket, three
// microgrids, three tenants on the first, and an org_manager who signs in
// with a random password. This file writes only the ids and the email to disk, for
// the narrow project and the teardown. The password is not secret: the
// Playwright report and a failed run's trace record it as typed, for a user
// the teardown deletes from a local database.

export const AUTH_DIR = path.join(__dirname, ".auth");
const FIXTURES_FILE = path.join(AUTH_DIR, "fixtures.json");

export type SmokeFixtures = { orgId: string; communityId: string; microgridId: string; email: string };

/**
 * The invoice logo: an 8 x 8 PNG, uploaded where the invoice-logo route puts
 * uploads (`<community id>/<name>.<ext>` in the private invoice-logos
 * bucket, src/app/api/communities/[id]/invoice-logo/route.ts). If that route
 * changes its bucket or path scheme, change these with it.
 */
const LOGO_BUCKET = "invoice-logos";
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mMQs4rHihiGlgQABocrwYGtYIoAAAAASUVORK5CYII=",
  "base64"
);

/** The app under test must use a local Supabase, as the rls suites do. */
function assertLocalSupabase(): void {
  const raw = process.env.MGM_PUBLIC_SUPABASE_URL ?? "";
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  // The fixtures go through rls.helpers, to LOCAL_SUPABASE_URL; the app must
  // read the same database.
  const fixturesPort = new URL(LOCAL_SUPABASE_URL).port;
  if (
    !url ||
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.port !== fixturesPort
  ) {
    throw new Error(
      "The browser smoke needs MGM_PUBLIC_SUPABASE_URL set to the local Supabase " +
        `(http on localhost, 127.0.0.1 or [::1], port ${fixturesPort}); see docs/setup.md, "Browser smoke test".`
    );
  }
}

async function must<T>(label: string, query: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`[browser smoke] ${label}: ${error.message}`);
  return data;
}

export async function createSmokeFixtures(): Promise<SmokeFixtures & { password: string }> {
  assertLocalSupabase();
  await deleteSmokeFixtures(); // rows left by an earlier, interrupted run
  const svc = await serviceClient();
  const tag = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const communityId = randomUUID();
  const microgridIds = [randomUUID(), randomUUID(), randomUUID()];
  const email = `smoke-${tag}@test.local`; // the domain the database suites use
  const password = randomBytes(18).toString("base64url");

  // Written first, so the teardown removes whatever the steps below created.
  mkdirSync(AUTH_DIR, { recursive: true });
  const fixtures: SmokeFixtures = { orgId, communityId, microgridId: microgridIds[0], email };
  writeFileSync(FIXTURES_FILE, JSON.stringify(fixtures));

  await must("organization", svc.from("organizations").insert({ id: orgId, name: `Smoke organization ${tag}` }));
  await must("community", svc.from("communities").insert({ id: communityId, org_id: orgId, name: "Smoke community" }));
  const logoPath = `${communityId}/smoke-logo.png`;
  await must(
    "invoice logo",
    svc.storage.from(LOGO_BUCKET).upload(logoPath, LOGO_PNG, { contentType: "image/png", upsert: true })
  );
  // communities.invoice_config, the JSONB the invoice page reads and the
  // invoice-config route writes (src/lib/invoices/config-schema.ts).
  await must(
    "invoice configuration",
    svc
      .from("communities")
      .update({ invoice_prefix: "SMOKE", invoice_config: { branding: { logo_storage_path: logoPath } } })
      .eq("id", communityId)
  );
  await must(
    "microgrids",
    svc.from("microgrids").insert(
      microgridIds.map((id, i) => ({ id, community_id: communityId, name: `Smoke microgrid ${i + 1}` }))
    )
  );
  await must(
    "tenants",
    svc.from("tenants").insert(
      [1, 2, 3].map((n) => ({
        microgrid_id: microgridIds[0],
        display_name: `Smoke tenant ${n} with a long display name`,
        account_number: `SMOKE-${tag}-${n}`,
        address_line1: `Plot ${n}, a long synthetic street name`,
        primary_phone: `+25670000000${n}`,
      }))
    )
  );
  const user = await createTestUser({ email, role: "org_manager", scopeId: orgId });
  const { error } = await svc.auth.admin.updateUserById(user.userId, { password });
  if (error) throw new Error(`[browser smoke] password: ${error.message}`);
  return { ...fixtures, password };
}

export function readSmokeFixtures(): SmokeFixtures {
  return JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as SmokeFixtures;
}

export async function deleteSmokeFixtures(): Promise<void> {
  if (!existsSync(FIXTURES_FILE)) return;
  assertLocalSupabase();
  const { orgId, communityId, email } = readSmokeFixtures();
  // Storage objects are not rows under the organization, so deleting it
  // leaves them; remove everything under the community's prefix first.
  if (communityId) {
    const svc = await serviceClient();
    const bucket = svc.storage.from(LOGO_BUCKET);
    const listed = (await must("invoice logos", bucket.list(communityId))) ?? [];
    if (listed.length > 0) {
      await must("invoice logos", bucket.remove(listed.map((object) => `${communityId}/${object.name}`)));
    }
  }
  await cleanupTestData({ orgIds: [orgId], userEmails: [email] });
  rmSync(FIXTURES_FILE);
}
