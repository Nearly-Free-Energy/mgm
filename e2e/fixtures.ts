import { randomUUID } from "node:crypto";
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
// microgrids, three tenants on the first, a tariff and a draft October 2026
// billing period on the first with bills for two of its tenants (one with no
// usage), a default sandbox Pesapal account for the organization, so the
// period's send queue shows a payment link, and an org_manager who signs in
// by email link (RFC #186), read
// from the local mail catcher. This file writes only the ids and the email
// to disk, for the narrow project and the teardown.

export const AUTH_DIR = path.join(__dirname, ".auth");
const FIXTURES_FILE = path.join(AUTH_DIR, "fixtures.json");

export type SmokeFixtures = { orgId: string; communityId: string; microgridId: string; periodId: string; email: string };

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
  const tenantIds = [randomUUID(), randomUUID(), randomUUID()];
  const scheduleId = randomUUID();
  const periodId = randomUUID();
  const email = `smoke-${tag}@test.local`; // the domain the database suites use

  // Written first, so the teardown removes whatever the steps below created.
  mkdirSync(AUTH_DIR, { recursive: true });
  const fixtures: SmokeFixtures = { orgId, communityId, microgridId: microgridIds[0], periodId, email };
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
        id: tenantIds[n - 1],
        microgrid_id: microgridIds[0],
        display_name: `Smoke tenant ${n} with a long display name`,
        account_number: `SMOKE-${tag}-${n}`,
        address_line1: `Plot ${n}, a long synthetic street name`,
        primary_phone: `+25670000000${n}`,
      }))
    )
  );
  // A draft period with its tariff pinned, so the close checklist loads
  // (src/lib/billing/surface/close-checklist.ts refuses a period without
  // one): two bills with whole totals, the second with no usage, and the
  // third tenant unbilled, so the close asks for every acknowledgement.
  await must(
    "rate schedule",
    svc.from("rate_schedules").insert({
      id: scheduleId,
      microgrid_id: microgridIds[0],
      tiers: [{ label: "Lifeline", min_kwh: 1, max_kwh: null, rate_per_kwh: 250 }],
      service_charge: 0,
      tax_rate: 0,
    })
  );
  await must(
    "billing period",
    svc.from("billing_periods").insert({
      id: periodId,
      microgrid_id: microgridIds[0],
      start_date: "2026-10-01",
      end_date: "2026-10-31",
      timezone: "Africa/Kampala",
      status: "draft",
      rate_schedule_id: scheduleId,
    })
  );
  await must(
    "bills",
    svc.from("billing_line_items").insert([
      {
        billing_period_id: periodId,
        tenant_id: tenantIds[0],
        start_kwh: 100,
        end_kwh: 110,
        usage_kwh: 10,
        tier_breakdown: [{ label: "Lifeline", kwh: 10, amount: 2500 }],
        total_amount: 2500,
        reading_source: "edge",
      },
      {
        billing_period_id: periodId,
        tenant_id: tenantIds[1],
        start_kwh: null,
        end_kwh: null,
        usage_kwh: null,
        tier_breakdown: [],
        total_amount: 0,
        reading_source: "edge",
      },
    ])
  );
  // The organization's default Pesapal account, as tested and registered, so
  // payment readiness is "sandbox" and the send queue shows the first bill's
  // link. Readiness reads only the database (getReadiness in
  // src/lib/payments/capability.ts), so loading the queue calls no provider;
  // no credential is stored, so nothing could. If readiness starts testing
  // the account live, take this out.
  await must(
    "payment account",
    svc.from("payment_merchant_accounts").insert({
      org_id: orgId,
      provider: "pesapal",
      is_default: true,
      sandbox: true,
      last_test_status: "success",
      ipn_id: `smoke-ipn-${tag}`,
    })
  );
  await createTestUser({ email, role: "org_manager", scopeId: orgId });
  return fixtures;
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
  // payment_merchant_versions references organizations without ON DELETE
  // CASCADE, so the payment account's versions go first, or the
  // organization's delete fails and cleanupTestData leaves it; if that
  // foreign key gains a cascade, this delete becomes a no-op.
  const svc = await serviceClient();
  await must("payment account versions", svc.from("payment_merchant_versions").delete().eq("org_id", orgId));
  await cleanupTestData({ orgIds: [orgId], userEmails: [email] });
  rmSync(FIXTURES_FILE);
}
