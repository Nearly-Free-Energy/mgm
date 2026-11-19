import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TENANT_APP_PLUGIN_NAME, TENANT_APP_PLUGIN_VERSION } from "@/lib/plugins/bundled";
import {
  cleanupTestData,
  createTestUser,
  LOCAL_SUPABASE_URL,
  serviceClient,
} from "../src/lib/supabase/__tests__/rls.helpers";

// The smoke's own rows: one organization, one community with an invoice
// configuration whose logo is an object in the invoice-logos bucket, three
// microgrids, three tenants on the first, and an org_manager who signs in
// by email link (RFC #186), read from the local mail catcher. The tenant
// app is on for that organization, and the first tenant's record lists one
// address with app access, long enough to need wrapping at 360 px, so the
// smoke opens Give access and the Remove confirmation. Beside it, in
// an organization of its own (so the manager's pages and counts do not
// change), one unit on a synthetic meter and the tenant who rents it
// (RFC mgm#197). This file writes only the ids and the emails to disk, for
// the other projects and the teardown.

export const AUTH_DIR = path.join(__dirname, ".auth");
const FIXTURES_FILE = path.join(AUTH_DIR, "fixtures.json");

/**
 * The tenant's ids are optional so that a fixtures file left by an older,
 * interrupted run still parses and its rows are still deleted.
 */
export type SmokeFixtures = {
  orgId: string;
  communityId: string;
  microgridId: string;
  email: string;
  tenantOrgId?: string;
  unitId?: string;
  tenantEmail?: string;
  /** The address with app access to the first smoke tenant. */
  accessEmail?: string;
};

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

export async function createSmokeFixtures(): Promise<SmokeFixtures> {
  assertLocalSupabase();
  await deleteSmokeFixtures(); // rows left by an earlier, interrupted run
  const svc = await serviceClient();
  const tag = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const communityId = randomUUID();
  const microgridIds = [randomUUID(), randomUUID(), randomUUID()];
  const email = `smoke-${tag}@test.local`; // the domain the database suites use
  // No break opportunity in 50-odd characters: wider than a 360 px line at the dialog's title size.
  const accessEmail = `smoke-access-${tag}-a-long-synthetic-renter-address@test.local`;

  // Written first, so the teardown removes whatever the steps below created.
  mkdirSync(AUTH_DIR, { recursive: true });
  const fixtures: SmokeFixtures = { orgId, communityId, microgridId: microgridIds[0], email, accessEmail };
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
  const tenantIds = [randomUUID(), randomUUID(), randomUUID()];
  await must(
    "tenants",
    svc.from("tenants").insert(
      [1, 2, 3].map((n) => ({
        id: tenantIds[n - 1],
        microgrid_id: microgridIds[0],
        display_name: `Smoke tenant ${n} with a long display name`,
        account_number: `SMOKE-${tag}-${n}`,
        address_line1: `Plot ${n}, a long synthetic street name`,
        primary_phone: `+25670000000${n}`,
      }))
    )
  );
  // The tenant app is off for an organization with no row for it
  // (defaultEnabled in src/lib/plugins/bundled.ts); on here, so the record
  // offers Give access.
  await must(
    "smoke tenant app",
    svc.from("mgm_plugins").insert({
      org_id: orgId,
      plugin_name: TENANT_APP_PLUGIN_NAME,
      version: TENANT_APP_PLUGIN_VERSION,
      enabled: true,
    })
  );
  await createTestUser({ email, role: "org_manager", scopeId: orgId });
  await createTestUser({ email: accessEmail, role: "tenant", scopeId: tenantIds[0] });
  return createTenantFixtures(fixtures, tag);
}

/**
 * The first day of the month `back` months before the current UTC month,
 * as YYYY-MM-DD.
 */
function firstOfMonthBefore(back: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 10);
}

/**
 * The tenant's rows: an organization with the tenant app turned on, a
 * microgrid in Kampala whose only edge is synthetic, so the fixture
 * metering provider serves it (MGM_METERING_FIXTURES in
 * playwright.config.ts; src/lib/metering/fixture/plugin.ts refuses a
 * microgrid that mixes synthetic and real edges, and one with no edge is
 * not synthetic), one consumption meter linked to the unit since the first
 * of the month two months back, so the whole previous month has figures,
 * and the tenant account. The ids are written before the inserts, so the
 * teardown removes whatever was created.
 */
async function createTenantFixtures(fixtures: SmokeFixtures, tag: string): Promise<SmokeFixtures> {
  const svc = await serviceClient();
  const tenantOrgId = randomUUID();
  const communityId = randomUUID();
  const microgridId = randomUUID();
  const edgeId = randomUUID();
  const deviceId = randomUUID();
  const unitId = randomUUID();
  const tenantEmail = `smoke-tenant-${tag}@test.local`;
  const withTenant: SmokeFixtures = { ...fixtures, tenantOrgId, unitId, tenantEmail };
  writeFileSync(FIXTURES_FILE, JSON.stringify(withTenant));

  await must(
    "tenant organization",
    svc.from("organizations").insert({ id: tenantOrgId, name: `Smoke tenant organization ${tag}` })
  );
  await must(
    "tenant community",
    svc.from("communities").insert({ id: communityId, org_id: tenantOrgId, name: "Smoke tenant community" })
  );
  await must(
    "tenant microgrid",
    svc.from("microgrids").insert({
      id: microgridId,
      community_id: communityId,
      name: "Smoke tenant microgrid",
      timezone: "Africa/Kampala",
      currency: "UGX",
    })
  );
  await must(
    "synthetic edge",
    svc.from("edges").insert({
      id: edgeId,
      microgrid_id: microgridId,
      name: "Smoke synthetic edge",
      openems_edge_id: `SYNTHETIC-EDGE-${microgridId}`,
    })
  );
  await must(
    "unit meter",
    svc.from("devices").insert({
      id: deviceId,
      edge_id: edgeId,
      name: "Smoke unit meter",
      device_type: "consumption_meter",
      openems_component_id: "meter1",
    })
  );
  await must(
    "unit",
    svc.from("tenants").insert({
      id: unitId,
      microgrid_id: microgridId,
      display_name: "Smoke unit",
      primary_phone: "+256700000009",
      account_number: `SMOKE-${tag}-U`,
    })
  );
  await must(
    "meter assignment",
    svc.from("tenant_devices").insert({
      tenant_id: unitId,
      device_id: deviceId,
      role: "primary_consumption_meter",
      effective_from: firstOfMonthBefore(2),
      effective_to: null,
    })
  );
  // The tenant app is off for an organization with no row for it
  // (defaultEnabled in src/lib/plugins/bundled.ts).
  await must(
    "tenant app",
    svc.from("mgm_plugins").insert({
      org_id: tenantOrgId,
      plugin_name: TENANT_APP_PLUGIN_NAME,
      version: TENANT_APP_PLUGIN_VERSION,
      enabled: true,
    })
  );
  await createTestUser({ email: tenantEmail, role: "tenant", scopeId: unitId });
  return withTenant;
}

/**
 * The local mail catcher's API (Mailpit, as `supabase start` runs it). The
 * app under test sends sign-in links there (MGM_SMTP_URL in
 * playwright.config.ts).
 */
const MAIL_CATCHER = process.env.MGM_MAIL_CATCHER_URL ?? "http://127.0.0.1:54324";

/** The sign-in link in the newest email to `email`, waiting up to 30 s for it to arrive. */
export async function signInLinkFor(email: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = await fetch(`${MAIL_CATCHER}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    if (found.ok) {
      const { messages } = (await found.json()) as { messages?: { ID: string }[] };
      if (messages?.length) {
        const message = await fetch(`${MAIL_CATCHER}/api/v1/message/${messages[0].ID}`);
        const { Text } = (await message.json()) as { Text: string };
        const link = /https?:\/\/\S+\/auth\/confirm\?token_hash=\S+/.exec(Text)?.[0];
        if (link) return link;
        throw new Error("[browser smoke] the sign-in email has no link");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`[browser smoke] no sign-in email reached ${MAIL_CATCHER} within 30 s`);
}

export function readSmokeFixtures(): SmokeFixtures {
  return JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as SmokeFixtures;
}

export async function deleteSmokeFixtures(): Promise<void> {
  if (!existsSync(FIXTURES_FILE)) return;
  assertLocalSupabase();
  const { orgId, communityId, email, tenantOrgId, tenantEmail, accessEmail } = readSmokeFixtures();
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
  await cleanupTestData({
    orgIds: [orgId, tenantOrgId].filter((id): id is string => Boolean(id)),
    userEmails: [email, tenantEmail, accessEmail].filter((address): address is string => Boolean(address)),
  });
  rmSync(FIXTURES_FILE);
}
