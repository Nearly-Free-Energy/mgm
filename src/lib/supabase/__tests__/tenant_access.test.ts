/**
 * tenant_access.test.ts — the tenant role against a real database
 * (RFC mgm#197, PR 1; migrations 20261118100000 and 20261118100100).
 *
 * A tenant is someone who rents a unit on a microgrid. Their access is a
 * user_roles row (user_id, 'tenant', 'tenant', tenants.id). This suite
 * proves what that row lets its holder read, that it lets them read nothing
 * staff-only, and how organization managers give and remove it.
 *
 * Fixture: one organization with one community and microgrid, an edge, four
 * devices, and three tenants on that microgrid:
 *   A — current primary meter DEVICE_A; DEVICE_MOVED was A's primary until
 *       2026-04-01 and is B's from then;
 *   B — DEVICE_MOVED and a secondary meter DEVICE_B;
 *   C — no meters; deleted by the cascade test.
 * DEVICE_SHARED is on the edge and assigned to nobody. Tenant A has a bill
 * and DEVICE_A a meter reading, so the staff tables hold rows of A's own,
 * and every other staff table gets one row of the organization's (payment
 * rows on A's bill), so the catalog sweep has something a tenant could
 * wrongly see in each. A second organization exists for the
 * cross-organization manager.
 *
 * Users:
 *   tenantOnly   — a tenant row for A and nothing else
 *   tenantOfC    — a tenant row for C and nothing else
 *   dual         — org manager of the organization, and tenant of A and C
 *   manager      — org manager of the organization
 *   otherManager — org manager of the other organization
 *   superAdmin   — super admin
 *   noRole       — an account with no role rows
 *   grantee      — no rows at first; given and then removed access to B
 *
 * The audit tests (named "audit: …") are one assertion per database-side
 * hit of the RFC § 4 "has any role" audit fixed in PR 1.
 *
 * Self-fixturing: everything is created in beforeAll under its own ids and
 * addresses, and removed in afterAll (the rows whose foreign keys do not
 * cascade, then users by address, then the organizations, whose cascade
 * takes the rest, tenant role rows included; the payment rows make that a
 * purge as the database owner, as cleanupTestData does for kept billing).
 * Opt-out: SKIP_RLS_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  LOCAL_SUPABASE_URL,
  runAsDatabaseOwner,
  serviceClient,
  shouldSkip,
  testAnonKey,
  type TestUser,
} from "./rls.helpers";
import { countEntityDescendants } from "@/lib/entity-descendants";
import { resolveTargetOrganization } from "@/lib/runtime/gate";

const F = {
  org: "7e4a0000-0000-4000-8000-000000000001",
  otherOrg: "7e4a0000-0000-4000-8000-000000000002",
  community: "7e4a0000-0000-4000-8001-000000000001",
  otherCommunity: "7e4a0000-0000-4000-8001-000000000002",
  microgrid: "7e4a0000-0000-4000-8002-000000000001",
  otherMicrogrid: "7e4a0000-0000-4000-8002-000000000002",
  edge: "7e4a0000-0000-4000-8003-000000000001",
  deviceA: "7e4a0000-0000-4000-8004-000000000001",
  deviceMoved: "7e4a0000-0000-4000-8004-000000000002",
  deviceB: "7e4a0000-0000-4000-8004-000000000003",
  deviceShared: "7e4a0000-0000-4000-8004-000000000004",
  tenantA: "7e4a0000-0000-4000-8005-000000000001",
  tenantB: "7e4a0000-0000-4000-8005-000000000002",
  tenantC: "7e4a0000-0000-4000-8005-000000000003",
  period: "7e4a0000-0000-4000-8006-000000000001",
  lineItem: "7e4a0000-0000-4000-8007-000000000001",
  merchant: "7e4a0000-0000-4000-8008-000000000001",
  attempt: "7e4a0000-0000-4000-8009-000000000001",
  unknown: "7e4a0000-0000-4000-80ff-000000000001",
};
/** The fixture's own keys in the staff tables that have no organization column. */
const SIGN_IN_HASH = "7e4a".repeat(16);
const TOKEN_LOOKUP = "7e4a0001";
const TRACKING = "tenant-access-tracking-1";
const REFERENCE = `TA-${F.attempt}`;

const EMAIL = {
  tenantOnly: "tenant-access-tenant-only@test.local",
  tenantOfC: "tenant-access-tenant-of-c@test.local",
  dual: "tenant-access-dual@test.local",
  manager: "tenant-access-manager@test.local",
  otherManager: "tenant-access-other-manager@test.local",
  superAdmin: "tenant-access-super-admin@test.local",
  noRole: "tenant-access-no-role@test.local",
  grantee: "tenant-access-grantee@test.local",
};
const ALL_EMAILS = Object.values(EMAIL);
const ORG_IDS = [F.org, F.otherOrg];
const LOGO_PATH = `${F.community}/tenant-access-logo.png`;

let tenantOnly: TestUser;
let tenantOfC: TestUser;
let dual: TestUser;
let manager: TestUser;
let otherManager: TestUser;
let superAdmin: TestUser;
let noRole: TestUser;
let grantee: TestUser;

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

// ── Helpers ───────────────────────────────────────────────────────────────

type PgError = { code?: string; message?: string } | null;

function expectCode(error: PgError, code: string): void {
  expect(error, `expected SQLSTATE ${code}`).not.toBeNull();
  expect(error?.code, `expected SQLSTATE ${code}; got ${error?.code} ${error?.message}`).toBe(code);
}

/** 42501 from a RAISE or the grant layer, or an RLS refusal of a write. */
function expectDenied(error: PgError): void {
  expect(error).not.toBeNull();
  expect(
    error?.code === "42501" || error?.message?.toLowerCase().includes("permission denied") ||
      error?.message?.toLowerCase().includes("row-level security"),
    `expected a permission error; got ${error?.code} ${error?.message}`,
  ).toBe(true);
}

/** CLAUDE.md: anon denial surfaces as 42501 or, once filtered from the schema cache, PGRST202. */
function expectAnonDenied(error: PgError): void {
  expect(error).not.toBeNull();
  expect(
    error?.code === "42501" ||
      error?.message?.toLowerCase().includes("permission denied") ||
      error?.code === "PGRST202",
    `expected 42501 or PGRST202; got ${error?.code} ${error?.message}`,
  ).toBe(true);
}

/**
 * Refused by the grant layer itself, not by the function's own RAISE: the
 * access functions raise 42501 themselves when the caller has no access,
 * so a bare 42501 cannot tell a missing REVOKE from a working one.
 */
function expectGrantLayerDenied(error: PgError): void {
  expect(error).not.toBeNull();
  expect(
    error?.code === "PGRST202" || error?.message?.toLowerCase().includes("permission denied for function"),
    `expected the grant layer to refuse (PGRST202 or "permission denied for function"); got ${error?.code} ${error?.message}`,
  ).toBe(true);
}

function anonClient(): SupabaseClient {
  const anonKey = testAnonKey();
  if (!anonKey) throw new Error("MGM_PUBLIC_SUPABASE_ANON_KEY not set");
  return createClient(LOCAL_SUPABASE_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Rows of one owner query, as `supabase db query -o json` prints them. */
function ownerRows<T>(sql: string): T[] {
  const result = runAsDatabaseOwner(sql);
  if (!result.ok) throw new Error(`[owner query] ${result.output}`);
  return JSON.parse(result.stdout) as T[];
}

function sessionCount(userId: string): { sessions: number; tokens: number } {
  const [row] = ownerRows<{ sessions: number; tokens: number }>(
    `SELECT (SELECT count(*) FROM auth.sessions WHERE user_id = '${userId}')::int AS sessions,
            (SELECT count(*) FROM auth.refresh_tokens WHERE user_id = '${userId}')::int AS tokens`,
  );
  return row;
}

/** One session with one refresh token, as a sign-in leaves behind. */
function addSession(userId: string): void {
  const result = runAsDatabaseOwner(
    `DO $$ DECLARE s uuid := gen_random_uuid(); BEGIN
       INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal)
       VALUES (s, '${userId}', now(), now(), 'aal1');
       INSERT INTO auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, session_id)
       VALUES ('tenant-access-' || s, '${userId}', false, now(), now(), s);
     END $$`,
  );
  if (!result.ok) throw new Error(`[session fixture] ${result.output}`);
}

async function accessIdOf(tenantId: string, email: string): Promise<string> {
  const { data, error } = await manager.client.rpc("fn_tenant_access_list", { _tenant_id: tenantId });
  expect(error).toBeNull();
  const row = (data as { access_id: string; email: string }[]).find((r) => r.email === email);
  if (!row) throw new Error(`no access for ${email} on ${tenantId}`);
  return row.access_id;
}

function pngBytes(): Blob {
  const data = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return new Blob([data], { type: "image/png" });
}

// ── Fixture ───────────────────────────────────────────────────────────────

async function insert(svc: SupabaseClient, table: string, rows: Record<string, unknown>[]): Promise<void> {
  const { error } = await svc.from(table).insert(rows);
  if (error) throw new Error(`[fixture] ${table}: ${error.message}`);
}

async function removeFixture(): Promise<void> {
  const svc = await serviceClient();
  await svc.storage.from("invoice-logos").remove([LOGO_PATH]);
  // These foreign keys do not cascade (pilot_import_batches to its period,
  // payment_merchant_versions to its organization), and auth_sign_in_requests
  // belongs to no organization, so they go first. The service role may not
  // delete import batches, so the owner does.
  const batches = runAsDatabaseOwner(`DELETE FROM public.pilot_import_batches WHERE billing_period_id = '${F.period}'`);
  if (!batches.ok) throw new Error(`[cleanup] pilot_import_batches: ${batches.output}`);
  for (const [table, run] of [
    ["payment_merchant_versions", () => svc.from("payment_merchant_versions").delete().in("org_id", ORG_IDS)],
    ["auth_sign_in_requests", () => svc.from("auth_sign_in_requests").delete().eq("email_hash", SIGN_IN_HASH)],
  ] as const) {
    const { error } = await run();
    if (error) throw new Error(`[cleanup] ${table}: ${error.message}`);
  }
  await cleanupTestData({ orgIds: ORG_IDS, userEmails: ALL_EMAILS });
}

/** One row in each staff table the base fixture leaves empty. */
async function insertStaffRows(svc: SupabaseClient): Promise<void> {
  const encrypted = await svc.rpc("fn_ems_encrypt_secret", { p_plaintext: "tenant-access-fixture" });
  if (encrypted.error || typeof encrypted.data !== "string") {
    throw new Error(`[fixture] encrypt: ${encrypted.error?.message}`);
  }
  await insert(svc, "rate_schedules", [{ microgrid_id: F.microgrid }]);
  await insert(svc, "grid_tariffs", [
    {
      microgrid_id: F.microgrid,
      effective_from: "2026-01-01",
      bands: [
        { from_hour: 0, to_hour: 18, rate: 400 },
        { from_hour: 18, to_hour: 24, rate: 650 },
      ],
    },
  ]);
  await insert(svc, "microgrid_savings_settings", [{ microgrid_id: F.microgrid }]);
  await insert(svc, "invoice_counters", [{ community_id: F.community, year: 2026, counter: 1 }]);
  await insert(svc, "mgm_plugins", [{ org_id: F.org, plugin_name: "billing", version: "1", enabled: true }]);
  await insert(svc, "mgm_plugin_audit_log", [
    { org_id: F.org, plugin_name: "billing", action: "enabled", previous_enabled: null, new_enabled: true },
  ]);
  await insert(svc, "billing_audit_log", [
    { billing_period_id: F.period, event_type: "period_created", actor_kind: "system", actor_ref: "tenant-access-fixture" },
  ]);
  await insert(svc, "org_api_tokens", [
    {
      org_id: F.org,
      name: "Tenant access token",
      token_lookup: TOKEN_LOOKUP,
      token_hash: "$argon2id$v=19$m=19456,t=2,p=1$placeholderforRLS",
      env_prefix: "dev_",
    },
  ]);
  await insert(svc, "organization_email_senders", [
    {
      org_id: F.org,
      host: "smtp.tenant-access.example",
      port: 587,
      username: "notices@tenant-access.example",
      password_encrypted: encrypted.data,
      from_address: "notices@tenant-access.example",
    },
  ]);
  // The account first: its snapshot trigger writes the version row an
  // attempt must name.
  await insert(svc, "payment_merchant_accounts", [{ id: F.merchant, org_id: F.org, display_name: "Tenant access merchant" }]);
  await insert(svc, "community_payment_overrides", [{ org_id: F.org, community_id: F.community, merchant_account_id: F.merchant }]);
  // Tenant A's bill, waiting on a manager: its only receipt failed, so the
  // reconciliation test below gets as far as the settlement check and no
  // further.
  await insert(svc, "payment_attempts", [
    {
      id: F.attempt,
      org_id: F.org,
      line_item_id: F.lineItem,
      community_id: F.community,
      merchant_account_id: F.merchant,
      merchant_account_version: 1,
      amount: 5000,
      currency: "UGX",
      bill_revision_total: 5000,
      merchant_reference: REFERENCE,
      provider_tracking_id: TRACKING,
      status: "needs_reconciliation",
    },
  ]);
  await insert(svc, "payment_receipts", [
    { org_id: F.org, attempt_id: F.attempt, amount: 5000, currency: "UGX", provider_status: "failed", provider_tracking_id: TRACKING },
  ]);
  await insert(svc, "payment_events", [
    {
      line_item_id: F.lineItem,
      from_status: "unpaid",
      to_status: "link_generated",
      source: "generate_link",
      actor_kind: "system",
      actor_ref: "tenant-access-fixture",
    },
  ]);
  await insert(svc, "payment_notifications", [{ org_id: F.org, tracking_id: TRACKING, merchant_reference: REFERENCE }]);
  await insert(svc, "pilot_import_batches", [{ billing_period_id: F.period, source_label: "synthetic-pilot" }]);
  await insert(svc, "auth_sign_in_requests", [{ email_hash: SIGN_IN_HASH, outcome: "no_access" }]);
}

beforeAll(async () => {
  if (skip) return;
  await assertEnvironmentReady();
  const svc = await serviceClient();
  await removeFixture();

  await insert(svc, "organizations", [
    { id: F.org, name: "Tenant access org" },
    { id: F.otherOrg, name: "Tenant access other org" },
  ]);
  await insert(svc, "communities", [
    { id: F.community, org_id: F.org, name: "Tenant access community" },
    { id: F.otherCommunity, org_id: F.otherOrg, name: "Tenant access other community" },
  ]);
  await insert(svc, "microgrids", [
    { id: F.microgrid, community_id: F.community, name: "Tenant access grid", currency: "UGX", timezone: "Africa/Kampala" },
    { id: F.otherMicrogrid, community_id: F.otherCommunity, name: "Tenant access other grid", currency: "UGX", timezone: "Africa/Kampala" },
  ]);
  await insert(svc, "edges", [
    { id: F.edge, microgrid_id: F.microgrid, name: "Tenant access edge", openems_edge_id: "tenant-access-edge" },
  ]);
  await insert(svc, "devices", [
    { id: F.deviceA, edge_id: F.edge, name: "Meter A", device_type: "consumption_meter", openems_component_id: "meter10" },
    { id: F.deviceMoved, edge_id: F.edge, name: "Meter moved", device_type: "consumption_meter", openems_component_id: "meter11" },
    { id: F.deviceB, edge_id: F.edge, name: "Meter B", device_type: "consumption_meter", openems_component_id: "meter12" },
    { id: F.deviceShared, edge_id: F.edge, name: "Shared meter", device_type: "consumption_meter", openems_component_id: "meter13" },
  ]);
  await insert(svc, "tenants", [
    { id: F.tenantA, microgrid_id: F.microgrid, display_name: "Unit A", unit_label: "A1", primary_phone: "+256700000101", geography_notes: "staff note" },
    { id: F.tenantB, microgrid_id: F.microgrid, display_name: "Unit B", unit_label: "B1", primary_phone: "+256700000102" },
    { id: F.tenantC, microgrid_id: F.microgrid, display_name: "Unit C", unit_label: "C1", primary_phone: "+256700000103" },
  ]);
  await insert(svc, "tenant_devices", [
    { tenant_id: F.tenantA, device_id: F.deviceA, role: "primary_consumption_meter", effective_from: "2026-04-01" },
    { tenant_id: F.tenantA, device_id: F.deviceMoved, role: "primary_consumption_meter", effective_from: "2026-01-01", effective_to: "2026-04-01" },
    { tenant_id: F.tenantB, device_id: F.deviceMoved, role: "primary_consumption_meter", effective_from: "2026-04-01" },
    { tenant_id: F.tenantB, device_id: F.deviceB, role: "secondary_meter", effective_from: "2026-01-01" },
  ]);
  await insert(svc, "meter_readings", [
    { device_id: F.deviceA, reading_kwh: 12.5, read_at: "2026-05-01T00:00:00Z" },
  ]);
  await insert(svc, "billing_periods", [
    { id: F.period, microgrid_id: F.microgrid, start_date: "2026-05-01", end_date: "2026-05-31", status: "draft" },
  ]);
  await insert(svc, "billing_line_items", [
    { id: F.lineItem, billing_period_id: F.period, tenant_id: F.tenantA, device_id: F.deviceA, usage_kwh: 10, total_amount: 5000 },
  ]);
  await insertStaffRows(svc);
  const upload = await svc.storage
    .from("invoice-logos")
    .upload(LOGO_PATH, pngBytes(), { contentType: "image/png", upsert: true });
  if (upload.error) throw new Error(`[fixture] invoice logo: ${upload.error.message}`);

  [tenantOnly, tenantOfC, dual, manager, otherManager, superAdmin, noRole, grantee] = await Promise.all([
    createTestUser({ email: EMAIL.tenantOnly, role: "tenant", scopeType: "tenant", scopeId: F.tenantA }),
    createTestUser({ email: EMAIL.tenantOfC, role: "tenant", scopeType: "tenant", scopeId: F.tenantC }),
    createTestUser({
      email: EMAIL.dual,
      role: "org_manager",
      scopeId: F.org,
      extraRoles: [
        { role: "tenant", scopeType: "tenant", scopeId: F.tenantA },
        { role: "tenant", scopeType: "tenant", scopeId: F.tenantC },
      ],
    }),
    createTestUser({ email: EMAIL.manager, role: "org_manager", scopeId: F.org }),
    createTestUser({ email: EMAIL.otherManager, role: "org_manager", scopeId: F.otherOrg }),
    createTestUser({ email: EMAIL.superAdmin, role: "super_admin" }),
    createTestUser({ email: EMAIL.noRole, role: null }),
    createTestUser({ email: EMAIL.grantee, role: null }),
  ]);
}, 90_000);

afterAll(async () => {
  if (skip) return;
  await removeFixture();
}, 60_000);

// ── What a tenant reads ───────────────────────────────────────────────────

desc("a tenant reads their own unit", () => {
  it("sees their own tenant row and not another tenant's on the same microgrid", async () => {
    const { data, error } = await tenantOnly.client.from("tenants").select("id");
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([F.tenantA]);
  });

  it("sees their own meter assignments, current and past, and not the next tenant's", async () => {
    const { data, error } = await tenantOnly.client
      .from("tenant_devices")
      .select("tenant_id, device_id")
      .order("effective_from");
    expect(error).toBeNull();
    expect(data).toEqual([
      { tenant_id: F.tenantA, device_id: F.deviceMoved },
      { tenant_id: F.tenantA, device_id: F.deviceA },
    ]);
  });

  it("sees the devices of their assignments and no other device on the edge", async () => {
    const { data, error } = await tenantOnly.client.from("devices").select("id");
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id).sort()).toEqual([F.deviceA, F.deviceMoved].sort());
  });

  it("user_can_access_tenant and user_is_tenant_of_device answer for the caller only", async () => {
    const check = async (client: SupabaseClient, fn: string, args: Record<string, string>) => {
      const { data, error } = await client.rpc(fn, args);
      expect(error).toBeNull();
      return data as boolean;
    };
    expect(await check(tenantOnly.client, "user_can_access_tenant", { _tenant_id: F.tenantA })).toBe(true);
    expect(await check(tenantOnly.client, "user_can_access_tenant", { _tenant_id: F.tenantB })).toBe(false);
    expect(await check(tenantOnly.client, "user_is_tenant_of_device", { _device_id: F.deviceA })).toBe(true);
    expect(await check(tenantOnly.client, "user_is_tenant_of_device", { _device_id: F.deviceMoved })).toBe(true);
    expect(await check(tenantOnly.client, "user_is_tenant_of_device", { _device_id: F.deviceB })).toBe(false);
    expect(await check(tenantOnly.client, "user_is_tenant_of_device", { _device_id: F.deviceShared })).toBe(false);
    // Neither includes staff (CLAUDE.md, helper table).
    expect(await check(superAdmin.client, "user_can_access_tenant", { _tenant_id: F.tenantA })).toBe(false);
    expect(await check(manager.client, "user_is_tenant_of_device", { _device_id: F.deviceA })).toBe(false);
  });

  it("reads only their own role row and their own profile", async () => {
    const roles = await tenantOnly.client.from("user_roles").select("role, scope_type, scope_id, user_id");
    expect(roles.error).toBeNull();
    expect(roles.data).toEqual([
      { role: "tenant", scope_type: "tenant", scope_id: F.tenantA, user_id: tenantOnly.userId },
    ]);
    const profiles = await tenantOnly.client.from("user_profiles").select("user_id");
    expect(profiles.error).toBeNull();
    expect((profiles.data ?? []).map((r) => r.user_id)).toEqual([tenantOnly.userId]);
  });

  it("a tenant row does not widen what staff read: the manager still sees every tenant", async () => {
    const { data } = await manager.client.from("tenants").select("id").eq("microgrid_id", F.microgrid);
    expect((data ?? []).map((r) => r.id).sort()).toEqual([F.tenantA, F.tenantB, F.tenantC].sort());
  });
});

desc("a tenant reads nothing staff-only", () => {
  // Every relation in public, read from the catalog. Visible to a tenant:
  // their own rows of these five, and nothing anywhere else.
  const OWN_ROWS: Record<string, number> = {
    tenants: 1,
    tenant_devices: 2,
    devices: 2,
    user_roles: 1,
    user_profiles: 1,
  };

  // A relation with no rows passes the sweep whatever its policies say, so
  // the fixture puts a row in every one, and this says, per relation, which
  // rows those are (a condition on the fixture's own ids, checked as the
  // owner). Where a tenant reads some rows of a relation, the row named is
  // someone else's. A new relation fails the sweep until it gets a fixture
  // row and an entry here, or an entry in EMPTY_OK with the reason it
  // cannot hold one.
  const fixtureRows = (): Record<string, string> => ({
    auth_sign_in_requests: `email_hash = '${SIGN_IN_HASH}'`,
    billing_audit_log: `billing_period_id = '${F.period}'`,
    billing_line_items: `tenant_id = '${F.tenantA}'`,
    billing_periods: `id = '${F.period}'`,
    communities: `org_id = '${F.org}'`,
    community_payment_overrides: `community_id = '${F.community}'`,
    devices: `id = '${F.deviceShared}'`,
    edges: `microgrid_id = '${F.microgrid}'`,
    grid_tariffs: `microgrid_id = '${F.microgrid}'`,
    invoice_counters: `community_id = '${F.community}'`,
    meter_readings: `device_id = '${F.deviceA}'`,
    mgm_plugin_audit_log: `org_id = '${F.org}'`,
    mgm_plugins: `org_id = '${F.org}'`,
    microgrid_recent_activity: `microgrid_id = '${F.microgrid}'`,
    microgrid_savings_settings: `microgrid_id = '${F.microgrid}'`,
    microgrid_shared_devices: `microgrid_id = '${F.microgrid}'`,
    microgrids: `id = '${F.microgrid}'`,
    org_api_tokens: `org_id = '${F.org}'`,
    organization_email_senders: `org_id = '${F.org}'`,
    organizations: `id = '${F.org}'`,
    payment_attempts: `line_item_id = '${F.lineItem}'`,
    payment_events: `line_item_id = '${F.lineItem}'`,
    payment_merchant_accounts: `org_id = '${F.org}'`,
    payment_merchant_versions: `org_id = '${F.org}'`,
    payment_notifications: `org_id = '${F.org}'`,
    payment_receipts: `org_id = '${F.org}'`,
    pilot_import_batches: `billing_period_id = '${F.period}'`,
    rate_schedules: `microgrid_id = '${F.microgrid}'`,
    tenant_access_accounts: `user_id = '${tenantOfC.userId}'`,
    tenant_devices: `tenant_id = '${F.tenantB}'`,
    tenants: `id = '${F.tenantB}'`,
    user_profiles: `user_id = '${manager.userId}'`,
    user_roles: `user_id = '${manager.userId}'`,
  });
  // Relations that cannot hold a fixture row, each with its reason. Empty
  // today; keep it short.
  const EMPTY_OK: Record<string, string> = {};

  it("every other table and view in public returns no rows", async () => {
    const relations = ownerRows<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p') ORDER BY 1`,
    ).map((r) => r.name);
    expect(relations).toEqual(expect.arrayContaining(["microgrids", "billing_line_items", "meter_readings"]));

    const rows = fixtureRows();
    const unlisted = relations.filter((name) => !(name in rows) && !(name in EMPTY_OK));
    expect(unlisted, "relations with no fixture row and no EMPTY_OK reason").toEqual([]);
    const counts = ownerRows<{ name: string; rows: number }>(
      relations
        .filter((name) => name in rows)
        .map((name) => `SELECT '${name}' AS name, (SELECT count(*) FROM public.${name} WHERE ${rows[name]})::int AS rows`)
        .join(" UNION ALL "),
    );
    const empty = counts.filter((r) => r.rows === 0).map((r) => r.name);
    expect(empty, "relations whose fixture row is missing, so the sweep would prove nothing there").toEqual([]);

    const visible: Record<string, number> = {};
    for (const name of relations) {
      const { count, error } = await tenantOnly.client.from(name).select("*", { count: "exact", head: true });
      // An error here is a refusal (no grant), which shows nothing.
      if (!error && (count ?? 0) > 0) visible[name] = count ?? 0;
    }
    expect(visible).toEqual(OWN_ROWS);
  });

  it("the microgrid, edge, community and organization of their own unit stay invisible", async () => {
    for (const [table, id] of [
      ["microgrids", F.microgrid],
      ["edges", F.edge],
      ["communities", F.community],
      ["organizations", F.org],
    ] as const) {
      const { data, error } = await tenantOnly.client.from(table).select("id").eq("id", id);
      expect(error).toBeNull();
      expect(data, table).toEqual([]);
    }
  });

  it("their own bill and their own meter's readings stay invisible in this slice", async () => {
    const bills = await tenantOnly.client.from("billing_line_items").select("id").eq("tenant_id", F.tenantA);
    expect(bills.data).toEqual([]);
    const readings = await tenantOnly.client.from("meter_readings").select("id").eq("device_id", F.deviceA);
    expect(readings.data).toEqual([]);
  });

  it("the staff helpers are false for a tenant", async () => {
    for (const [fn, args] of [
      ["is_super_admin", {}],
      ["user_can_access_org", { _org_id: F.org }],
      ["user_can_access_microgrid", { _microgrid_id: F.microgrid }],
      ["user_can_access_community", { _community_id: F.community }],
    ] as const) {
      const { data, error } = await tenantOnly.client.rpc(fn, args);
      expect(error, fn).toBeNull();
      expect(data, fn).toBe(false);
    }
  });

  it("the invoice-logos objects of their community stay invisible and closed to uploads", async () => {
    const listed = await tenantOnly.client.storage.from("invoice-logos").list(F.community);
    expect(listed.data ?? []).toEqual([]);
    const uploaded = await tenantOnly.client.storage
      .from("invoice-logos")
      .upload(`${F.community}/tenant-upload.png`, pngBytes(), { contentType: "image/png" });
    expect(uploaded.error).not.toBeNull();
  });

  it("the staff RPCs refuse a tenant or answer nothing", async () => {
    const operators = await tenantOnly.client.rpc("fn_list_ems_operators", { _microgrid_id: F.microgrid });
    expect(operators.error).toBeNull();
    expect(operators.data).toEqual([]);

    const period = await tenantOnly.client.rpc("fn_create_billing_period", {
      _microgrid_id: F.microgrid,
      _start_date: "2026-06-01",
      _end_date: "2026-06-30",
    });
    expectDenied(period.error);

    const deleted = await tenantOnly.client.rpc("fn_entity_delete_microgrid", { p_id: F.microgrid });
    expect(deleted.data ?? 0).toBe(0);
  });
});

desc("a tenant writes nothing", () => {
  it("cannot change their tenant row, its assignments, or their devices", async () => {
    const svc = await serviceClient();

    const updated = await tenantOnly.client.from("tenants").update({ display_name: "Changed" }).eq("id", F.tenantA).select();
    expect(updated.data ?? []).toEqual([]);
    const inserted = await tenantOnly.client
      .from("tenants")
      .insert({ microgrid_id: F.microgrid, display_name: "New", primary_phone: "+256700000199" });
    expectDenied(inserted.error);

    const removed = await tenantOnly.client.from("tenant_devices").delete().eq("tenant_id", F.tenantA).select();
    expect(removed.data ?? []).toEqual([]);
    const assigned = await tenantOnly.client
      .from("tenant_devices")
      .insert({ tenant_id: F.tenantA, device_id: F.deviceShared, role: "secondary_meter" });
    expectDenied(assigned.error);
    const replaced = await tenantOnly.client.rpc("fn_replace_tenant_device", {
      p_tenant_id: F.tenantA,
      p_device_id: F.deviceShared,
      p_effective_date: "2026-06-01",
    });
    expect(replaced.error).not.toBeNull();

    const renamed = await tenantOnly.client.from("devices").update({ name: "Mine" }).eq("id", F.deviceA).select();
    expect(renamed.data ?? []).toEqual([]);
    const created = await tenantOnly.client
      .from("devices")
      .insert({ edge_id: F.edge, name: "Rogue", device_type: "consumption_meter", openems_component_id: "meter99" });
    expectDenied(created.error);

    const tenant = await svc.from("tenants").select("display_name").eq("id", F.tenantA).single();
    expect(tenant.data?.display_name).toBe("Unit A");
    const links = await svc.from("tenant_devices").select("id").eq("tenant_id", F.tenantA);
    expect(links.data).toHaveLength(2);
    const device = await svc.from("devices").select("name").eq("id", F.deviceA).single();
    expect(device.data?.name).toBe("Meter A");
  });

  it("cannot write user_roles, not even their own row", async () => {
    const svc = await serviceClient();
    const added = await tenantOnly.client
      .from("user_roles")
      .insert({ user_id: tenantOnly.userId, role: "tenant", scope_type: "tenant", scope_id: F.tenantB });
    expectDenied(added.error);
    const removed = await tenantOnly.client.from("user_roles").delete().eq("user_id", tenantOnly.userId).select();
    expect(removed.data ?? []).toEqual([]);
    const { data } = await svc.from("user_roles").select("scope_id").eq("user_id", tenantOnly.userId);
    expect(data).toEqual([{ scope_id: F.tenantA }]);
  });
});

// ── Columns a tenant can read ─────────────────────────────────────────────

desc("columns readable by a tenant", () => {
  // A policy is row-level: a tenant reads every column of their own rows of
  // these tables (CLAUDE.md, "Every column of tenants, tenant_devices and
  // devices"). Adding a column means deciding whether its tenant may read
  // it; this list fails until someone has.
  const TENANT_READABLE: Record<string, string[]> = {
    tenants: [
      "account_number", "address_city", "address_country", "address_line1", "address_line2",
      "address_postal_code", "address_region", "created_at", "customer_type", "display_name",
      "geography_notes", "id", "meter_serial", "meter_type", "microgrid_id", "primary_email",
      "primary_phone", "unit_label",
    ],
    tenant_devices: ["created_at", "device_id", "effective_from", "effective_to", "id", "role", "tenant_id"],
    devices: ["config", "created_at", "device_type", "edge_id", "id", "name", "openems_component_id"],
  };

  it("pins the columns of tenants, tenant_devices and devices", () => {
    const rows = ownerRows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('tenants', 'tenant_devices', 'devices')
        ORDER BY table_name, column_name`,
    );
    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[r.table_name] ??= []).push(r.column_name);
    expect(actual).toEqual(TENANT_READABLE);
  });
});

// ── fn_tenant_home ────────────────────────────────────────────────────────

desc("fn_tenant_home", () => {
  it("returns exactly the allowed columns for the caller's own unit", async () => {
    const { data, error } = await tenantOnly.client.rpc("fn_tenant_home", { _tenant_id: F.tenantA });
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        tenant_id: F.tenantA,
        display_name: "Unit A",
        unit_label: "A1",
        microgrid_id: F.microgrid,
        microgrid_name: "Tenant access grid",
        timezone: "Africa/Kampala",
        currency: "UGX",
        organization_id: F.org,
      },
    ]);
  });

  it("returns nothing for another tenant, or for staff without a tenant row", async () => {
    for (const [client, tenant] of [
      [tenantOnly.client, F.tenantB],
      [manager.client, F.tenantA],
      [superAdmin.client, F.tenantA],
    ] as const) {
      const { data, error } = await client.rpc("fn_tenant_home", { _tenant_id: tenant });
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
  });

  it("serves a manager who also rents for their own unit", async () => {
    const { data } = await dual.client.rpc("fn_tenant_home", { _tenant_id: F.tenantA });
    expect((data as unknown[]).length).toBe(1);
  });
});

// ── Audit hits fixed in PR 1 ──────────────────────────────────────────────

desc("audit: user_roles_role_scope_type_consistent", () => {
  it("rejects tenant rows off the tenant scope, staff rows on it, and a tenant row without a tenant", async () => {
    const svc = await serviceClient();
    for (const row of [
      { role: "tenant", scope_type: "org", scope_id: F.org },
      { role: "tenant", scope_type: "microgrid", scope_id: F.microgrid },
      { role: "tenant", scope_type: "tenant", scope_id: null },
      { role: "org_manager", scope_type: "tenant", scope_id: F.tenantB },
      { role: "super_admin", scope_type: "tenant", scope_id: F.tenantB },
      { role: "ems_operator", scope_type: "tenant", scope_id: F.tenantB },
    ]) {
      const { error } = await svc.from("user_roles").insert({ user_id: noRole.userId, ...row });
      expectCode(error, "23514");
    }
    const { data } = await svc.from("user_roles").select("id").eq("user_id", noRole.userId);
    expect(data).toEqual([]);
  });
});

desc("audit: fn_list_visible_users lists staff only", () => {
  it("a super admin does not see tenant-only people, and still sees people with no rows", async () => {
    const { data, error } = await superAdmin.client.rpc("fn_list_visible_users");
    expect(error).toBeNull();
    const rows = data as { user_id: string; role: string | null }[];
    const ids = rows.map((r) => r.user_id);
    expect(ids).not.toContain(tenantOnly.userId);
    expect(ids).not.toContain(tenantOfC.userId);
    expect(rows.find((r) => r.user_id === noRole.userId)?.role).toBeNull();
    expect(rows.filter((r) => r.user_id === dual.userId).map((r) => r.role)).toEqual(["org_manager"]);
  });

  it("a tenant sees no one, not even themselves (the list is of staff), and no one they name", async () => {
    const self = await tenantOnly.client.rpc("fn_list_visible_users");
    expect(self.error).toBeNull();
    expect(self.data).toEqual([]);
    const named = await tenantOnly.client.rpc("fn_list_visible_users", { _target_user_ids: [manager.userId] });
    expect(named.data).toEqual([]);
  });

  it("user_can_see_user_profile stays false across the staff/tenant line", async () => {
    const asTenant = await tenantOnly.client.rpc("user_can_see_user_profile", { _target_user_id: manager.userId });
    expect(asTenant.data).toBe(false);
    const asManager = await manager.client.rpc("user_can_see_user_profile", { _target_user_id: tenantOnly.userId });
    expect(asManager.data).toBe(false);
  });
});

desc("audit: fn_ems_encrypt_secret requires staff or the service role", () => {
  it("refuses a tenant and an account with no role rows", async () => {
    for (const user of [tenantOnly, noRole]) {
      const { data, error } = await user.client.rpc("fn_ems_encrypt_secret", { p_plaintext: "x" });
      expectCode(error, "42501");
      expect(data).toBeNull();
    }
  });

  it("still encrypts for an org manager and the service role", async () => {
    const asManager = await manager.client.rpc("fn_ems_encrypt_secret", { p_plaintext: "x" });
    expect(asManager.error).toBeNull();
    expect(asManager.data).toBeTruthy();
    const svc = await serviceClient();
    const asService = await svc.rpc("fn_ems_encrypt_secret", { p_plaintext: "x" });
    expect(asService.error).toBeNull();
    expect(asService.data).toBeTruthy();
  });

  // A direct database session carries no JWT. Migrations and key rotation
  // connect through different logins (postgres locally, cli_login_postgres
  // under `supabase db push`), so the function lets one through by
  // membership in postgres, not by name. This harness connects only as
  // postgres, which cannot grant membership in itself, so it cannot open a
  // session as another member; these three pin the rule instead.
  it("lets a direct session through by membership in postgres, not by login name", () => {
    const [row] = ownerRows<{ def: string }>(
      "SELECT pg_get_functiondef('public.fn_ems_encrypt_secret(text)'::regprocedure) AS def",
    );
    expect(row.def).toContain("pg_has_role(session_user, 'postgres', 'MEMBER')");
    expect(row.def).not.toMatch(/session_user\s+(NOT\s+)?IN\s*\(/i);
  });

  it("encrypts in a direct session as the owner, which carries no JWT", () => {
    const [row] = ownerRows<{ ok: boolean }>("SELECT public.fn_ems_encrypt_secret('x') IS NOT NULL AS ok");
    expect(row.ok).toBe(true);
  });

  it("PostgREST's login role and the API roles are not members of postgres", () => {
    const rows = ownerRows<{ role: string; member: boolean }>(
      `SELECT r AS role, pg_has_role(r, 'postgres', 'MEMBER') AS member
         FROM unnest(ARRAY['anon', 'authenticated', 'authenticator', 'service_role']) AS r ORDER BY 1`,
    );
    expect(rows).toEqual([
      { role: "anon", member: false },
      { role: "authenticated", member: false },
      { role: "authenticator", member: false },
      { role: "service_role", member: false },
    ]);
  });
});

desc("audit: fn_payment_reconcile authorizes its actor by staff row", () => {
  it("refuses a tenant-only actor, and lets the organization's manager past the check", async () => {
    const svc = await serviceClient();
    const args = { _attempt_id: F.attempt, _action: "accept_exact", _external_amount: 0, _reference: "", _notes: "" };
    const asTenant = await svc.rpc("fn_payment_reconcile", { ...args, _actor: tenantOnly.userId });
    expectCode(asTenant.error, "42501");
    // The control: a manager of the organization gets past the actor check
    // and stops at the settlement check, since the fixture's only receipt
    // failed. So the tenant's refusal came from the actor check.
    const asManager = await svc.rpc("fn_payment_reconcile", { ...args, _actor: manager.userId });
    expect(asManager.error?.code).not.toBe("42501");
    expect(asManager.error?.message).toContain("receipts are not exact settlement");

    const attempt = await svc.from("payment_attempts").select("status").eq("id", F.attempt).single();
    expect(attempt.data?.status).toBe("needs_reconciliation");
    const bill = await svc.from("billing_line_items").select("payment_status").eq("id", F.lineItem).single();
    expect(bill.data?.payment_status).toBe("unpaid");
  });
});

desc("audit: the user_roles policies and role functions do not reach tenant rows", () => {
  it("an org manager cannot delete a tenant's role row directly (fn_tenant_access_revoke is the way)", async () => {
    const removed = await manager.client.from("user_roles").delete().eq("user_id", tenantOnly.userId).select();
    expect(removed.data ?? []).toEqual([]);
    const svc = await serviceClient();
    const { data } = await svc.from("user_roles").select("scope_id").eq("user_id", tenantOnly.userId);
    expect(data).toEqual([{ scope_id: F.tenantA }]);
  });

  it("a tenant row is no permission to assign staff roles", async () => {
    const changed = await tenantOnly.client.rpc("fn_change_user_role", {
      p_user_id: noRole.userId,
      p_role: "org_manager",
      p_scope_id: F.org,
      p_scope_type: "org",
    });
    expectCode(changed.error, "42501");
    const svc = await serviceClient();
    const { data } = await svc.from("user_roles").select("id").eq("user_id", noRole.userId);
    expect(data).toEqual([]);
  });
});

desc("audit: tenant_users is gone; tenant access is counted from the role rows", () => {
  it("drops tenant_users", () => {
    const [row] = ownerRows<{ exists: boolean }>(
      "SELECT to_regclass('public.tenant_users') IS NOT NULL AS exists",
    );
    expect(row.exists).toBe(false);
  });

  it("fn_tenant_access_count counts a manager's tenants and nobody else's", async () => {
    const asManager = await manager.client.rpc("fn_tenant_access_count", {
      _tenant_ids: [F.tenantA, F.tenantB, F.tenantC],
    });
    expect(asManager.error).toBeNull();
    // A: tenantOnly and dual; C: tenantOfC and dual.
    expect(asManager.data).toBe(4);
    for (const client of [otherManager.client, tenantOnly.client]) {
      const { data } = await client.rpc("fn_tenant_access_count", { _tenant_ids: [F.tenantA] });
      expect(data).toBe(0);
    }
  });

  it("the delete preview counts tenant access under a microgrid for its manager", async () => {
    const counts = await countEntityDescendants(manager.client, "microgrid", F.microgrid);
    expect(counts.kind).toBe("microgrid");
    if (counts.kind !== "microgrid") return;
    expect(counts.tenant_access).toBe(4);
  });
});

desc("audit: the gate's tenant and device lookups resolve nothing for a tenant", () => {
  it("returns no organization for a tenant's own unit and device, and the right one for staff", async () => {
    expect(await resolveTargetOrganization(tenantOnly.client, { kind: "tenant", id: F.tenantA })).toBeNull();
    expect(await resolveTargetOrganization(tenantOnly.client, { kind: "device", id: F.deviceA })).toBeNull();
    expect(await resolveTargetOrganization(manager.client, { kind: "tenant", id: F.tenantA })).toBe(F.org);
  });
});

desc("the staff role functions keep refusing the tenant role", () => {
  it("fn_finalize_user_invitation and fn_change_user_role reject 'tenant' (22023)", async () => {
    const invited = await superAdmin.client.rpc("fn_finalize_user_invitation", {
      p_user_id: noRole.userId,
      p_first_name: "A",
      p_last_name: "B",
      p_phone: null,
      p_role: "tenant",
      p_scope_id: F.tenantA,
    });
    expectCode(invited.error, "22023");
    const changed = await superAdmin.client.rpc("fn_change_user_role", {
      p_user_id: noRole.userId,
      p_role: "tenant",
      p_scope_id: F.tenantA,
      p_scope_type: "tenant",
    });
    expectCode(changed.error, "22023");
  });

  it("fn_change_user_role on the org path leaves a person's tenant rows alone", async () => {
    const { error } = await superAdmin.client.rpc("fn_change_user_role", {
      p_user_id: dual.userId,
      p_role: "org_manager",
      p_scope_id: F.org,
      p_scope_type: "org",
    });
    expect(error).toBeNull();
    const svc = await serviceClient();
    const { data } = await svc.from("user_roles").select("role, scope_id").eq("user_id", dual.userId).order("role");
    expect(data).toEqual(
      expect.arrayContaining([
        { role: "org_manager", scope_id: F.org },
        { role: "tenant", scope_id: F.tenantA },
        { role: "tenant", scope_id: F.tenantC },
      ]),
    );
    expect(data).toHaveLength(3);
  });

  it("a tenant still gets a sign-in link: fn_auth_sign_in_target accepts any role row", async () => {
    const svc = await serviceClient();
    const { data } = await svc.rpc("fn_auth_sign_in_target", { _email: EMAIL.tenantOnly });
    expect(data).toBe(tenantOnly.userId);
  });
});

// ── Giving and removing access ────────────────────────────────────────────

desc("fn_tenant_access_grant, _list and _revoke", () => {
  // The grant is the service role's only, on behalf of a manager (_actor):
  // the access route picks the account from the address the manager typed.
  const grant = async (tenantId: string, userId: string, actor: string) => {
    const svc = await serviceClient();
    return svc.rpc("fn_tenant_access_grant", { _tenant_id: tenantId, _user_id: userId, _actor: actor });
  };

  it("refuse a tenant and a manager of another organization (42501)", async () => {
    for (const user of [tenantOnly, otherManager, noRole]) {
      const granted = await grant(F.tenantA, grantee.userId, user.userId);
      expectCode(granted.error, "42501");
      const listed = await user.client.rpc("fn_tenant_access_list", { _tenant_id: F.tenantA });
      expectCode(listed.error, "42501");
      const revoked = await user.client.rpc("fn_tenant_access_revoke", { _tenant_id: F.tenantA, _access_id: F.unknown });
      expectCode(revoked.error, "42501");
    }
    const svc = await serviceClient();
    const { data } = await svc.from("user_roles").select("id").eq("user_id", grantee.userId);
    expect(data).toEqual([]);
  });

  it("a signed-in caller cannot grant, so cannot attach an account they know only by id and read its address", async () => {
    // A manager can read a super admin's or another organization's
    // manager's id (created_by, actor_user_id columns). Naming it to the
    // grant is refused by the grant layer, whoever calls.
    for (const target of [superAdmin, otherManager]) {
      const named = await manager.client.rpc("fn_tenant_access_grant", {
        _tenant_id: F.tenantA,
        _user_id: target.userId,
        _actor: manager.userId,
      });
      expectGrantLayerDenied(named.error);
    }
    const asSuperAdmin = await superAdmin.client.rpc("fn_tenant_access_grant", {
      _tenant_id: F.tenantA,
      _user_id: grantee.userId,
      _actor: superAdmin.userId,
    });
    expectGrantLayerDenied(asSuperAdmin.error);

    const { data, error } = await manager.client.rpc("fn_tenant_access_list", { _tenant_id: F.tenantA });
    expect(error).toBeNull();
    const emails = (data as { email: string }[]).map((r) => r.email);
    expect(emails).not.toContain(EMAIL.superAdmin);
    expect(emails).not.toContain(EMAIL.otherManager);
    const svc = await serviceClient();
    for (const target of [superAdmin, otherManager]) {
      const { data: rows } = await svc.from("user_roles").select("role").eq("user_id", target.userId).eq("role", "tenant");
      expect(rows).toEqual([]);
    }
  });

  it("list the addresses with access, by access id and never by user id", async () => {
    const { data, error } = await manager.client.rpc("fn_tenant_access_list", { _tenant_id: F.tenantA });
    expect(error).toBeNull();
    const rows = data as Record<string, unknown>[];
    expect(rows.map((r) => r.email).sort()).toEqual([EMAIL.dual, EMAIL.tenantOnly].sort());
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["access_id", "created_at", "email"]);
  });

  it("report an unknown tenant or user", async () => {
    const unknownUser = await grant(F.tenantB, F.unknown, manager.userId);
    expectCode(unknownUser.error, "P0002");
    // To a manager an unknown tenant is not theirs; only a super admin learns it does not exist.
    const asManager = await grant(F.unknown, grantee.userId, manager.userId);
    expectCode(asManager.error, "42501");
    const asSuperAdmin = await grant(F.unknown, grantee.userId, superAdmin.userId);
    expectCode(asSuperAdmin.error, "P0002");
    // No actor, or an actor who is no one, is refused like a stranger.
    const noActor = await grant(F.tenantB, grantee.userId, F.unknown);
    expectCode(noActor.error, "42501");
  });

  it("a manager grants, idempotently, and the grantee then reads the unit", async () => {
    const first = await grant(F.tenantB, grantee.userId, manager.userId);
    expect(first.error).toBeNull();
    const again = await grant(F.tenantB, grantee.userId, superAdmin.userId);
    expect(again.error).toBeNull();
    expect(again.data).toBe(first.data);

    const { data } = await grantee.client.from("tenants").select("id");
    expect((data ?? []).map((r) => r.id)).toEqual([F.tenantB]);
    const devices = await grantee.client.from("devices").select("id");
    expect((devices.data ?? []).map((r) => r.id).sort()).toEqual([F.deviceB, F.deviceMoved].sort());
  });

  it("a revoke refuses an access id that belongs to another tenant", async () => {
    const tenantOnlyAccess = await accessIdOf(F.tenantA, EMAIL.tenantOnly);
    const { error } = await manager.client.rpc("fn_tenant_access_revoke", {
      _tenant_id: F.tenantB,
      _access_id: tenantOnlyAccess,
    });
    expectCode(error, "P0002");
    expect(await accessIdOf(F.tenantA, EMAIL.tenantOnly)).toBe(tenantOnlyAccess);
  });

  it("revoking a person's last role row ends their sessions", async () => {
    addSession(grantee.userId);
    expect(sessionCount(grantee.userId)).toEqual({ sessions: 1, tokens: 1 });

    const access = await accessIdOf(F.tenantB, EMAIL.grantee);
    const { data, error } = await manager.client.rpc("fn_tenant_access_revoke", {
      _tenant_id: F.tenantB,
      _access_id: access,
    });
    expect(error).toBeNull();
    expect(data).toBe(true);
    expect(sessionCount(grantee.userId)).toEqual({ sessions: 0, tokens: 0 });

    const reads = await grantee.client.from("tenants").select("id");
    expect(reads.data).toEqual([]);
    const svc = await serviceClient();
    const target = await svc.rpc("fn_auth_sign_in_target", { _email: EMAIL.grantee });
    expect(target.data).toBeNull();
  });

  it("a former tenant stays off the Users page once their last row is gone", async () => {
    // grantee now holds no row at all, like a person whose staff access was
    // removed, but was a tenant: decision 5 keeps them off the list.
    const svc = await serviceClient();
    const { data: rows } = await svc.from("user_roles").select("id").eq("user_id", grantee.userId);
    expect(rows).toEqual([]);
    const { data, error } = await superAdmin.client.rpc("fn_list_visible_users");
    expect(error).toBeNull();
    const ids = (data as { user_id: string }[]).map((r) => r.user_id);
    expect(ids).not.toContain(grantee.userId);
    expect(ids).toContain(noRole.userId);
  });

  it("revoking a row when the person keeps another role leaves their sessions, even for their own row", async () => {
    addSession(dual.userId);
    const access = await accessIdOf(F.tenantA, EMAIL.dual);
    // The manager gives up their own unit access: not a self-revocation of staff access.
    const { data, error } = await dual.client.rpc("fn_tenant_access_revoke", {
      _tenant_id: F.tenantA,
      _access_id: access,
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
    expect(sessionCount(dual.userId)).toEqual({ sessions: 1, tokens: 1 });

    const svc = await serviceClient();
    const { data: rows } = await svc.from("user_roles").select("role, scope_id").eq("user_id", dual.userId);
    expect(rows).toEqual(
      expect.arrayContaining([
        { role: "org_manager", scope_id: F.org },
        { role: "tenant", scope_id: F.tenantC },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

// ── Cascade ───────────────────────────────────────────────────────────────

desc("audit: scope_tenant_id and the delete guard", () => {
  it("a manager who rents unit C deletes C; its access rows go, their manager row stays", async () => {
    const { error } = await dual.client.from("tenants").delete().eq("id", F.tenantC);
    expect(error).toBeNull();

    const svc = await serviceClient();
    const gone = await svc.from("user_roles").select("id").eq("scope_id", F.tenantC);
    expect(gone.data).toEqual([]);
    const kept = await svc.from("user_roles").select("role, scope_id").eq("user_id", dual.userId);
    expect(kept.data).toEqual([{ role: "org_manager", scope_id: F.org }]);

    const target = await svc.rpc("fn_auth_sign_in_target", { _email: EMAIL.tenantOfC });
    expect(target.data).toBeNull();

    // C's only tenant, now with no rows, stays off the Users page.
    const listed = await superAdmin.client.rpc("fn_list_visible_users", { _target_user_ids: [tenantOfC.userId] });
    expect(listed.error).toBeNull();
    expect(listed.data).toEqual([]);
  });
});

// ── anon ──────────────────────────────────────────────────────────────────

desc("anon is denied every new function", () => {
  const CALLS: [string, Record<string, unknown>][] = [
    ["user_can_access_tenant", { _tenant_id: F.tenantA }],
    ["user_is_tenant_of_device", { _device_id: F.deviceA }],
    ["fn_tenant_home", { _tenant_id: F.tenantA }],
    ["fn_tenant_access_grant", { _tenant_id: F.tenantA, _user_id: F.unknown, _actor: F.unknown }],
    ["fn_tenant_access_revoke", { _tenant_id: F.tenantA, _access_id: F.unknown }],
    ["fn_tenant_access_list", { _tenant_id: F.tenantA }],
    ["fn_tenant_access_count", { _tenant_ids: [F.tenantA] }],
  ];

  // Through PostgREST, the grant layer must be what refuses: the access
  // functions raise 42501 themselves for a caller without a session, which
  // would pass a looser check with anon's EXECUTE granted.
  it.each(CALLS)("anon cannot call %s", async (fn, args) => {
    const { error } = await anonClient().rpc(fn, args);
    expectAnonDenied(error);
    expectGrantLayerDenied(error);
  });

  it("the grants themselves: no EXECUTE for anon on any, and the grant and trigger function for the service role only", () => {
    const rows = ownerRows<{ signature: string; anon: boolean; authenticated: boolean; service_role: boolean }>(
      `SELECT s AS signature,
              has_function_privilege('anon', s, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', s, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', s, 'EXECUTE') AS service_role
         FROM unnest(ARRAY[
           'public.user_can_access_tenant(uuid)',
           'public.user_is_tenant_of_device(uuid)',
           'public.fn_tenant_home(uuid)',
           'public.fn_tenant_access_grant(uuid, uuid, uuid)',
           'public.fn_tenant_access_revoke(uuid, uuid)',
           'public.fn_tenant_access_list(uuid)',
           'public.fn_tenant_access_count(uuid[])',
           'public.fn_user_roles_record_tenant_account()'
         ]) AS s`,
    );
    const both = { anon: false, authenticated: true, service_role: true };
    const serviceOnly = { anon: false, authenticated: false, service_role: true };
    expect(rows).toEqual([
      { signature: "public.user_can_access_tenant(uuid)", ...both },
      { signature: "public.user_is_tenant_of_device(uuid)", ...both },
      { signature: "public.fn_tenant_home(uuid)", ...both },
      { signature: "public.fn_tenant_access_grant(uuid, uuid, uuid)", ...serviceOnly },
      { signature: "public.fn_tenant_access_revoke(uuid, uuid)", ...both },
      { signature: "public.fn_tenant_access_list(uuid)", ...both },
      { signature: "public.fn_tenant_access_count(uuid[])", ...both },
      { signature: "public.fn_user_roles_record_tenant_account()", ...serviceOnly },
    ]);
  });

  it("tenant_access_accounts is closed to the API roles", () => {
    const [row] = ownerRows<{ anon: boolean; authenticated: boolean; rls: boolean }>(
      `SELECT has_table_privilege('anon', 'public.tenant_access_accounts', 'SELECT') AS anon,
              has_table_privilege('authenticated', 'public.tenant_access_accounts', 'SELECT') AS authenticated,
              (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tenant_access_accounts'::regclass) AS rls`,
    );
    expect(row).toEqual({ anon: false, authenticated: false, rls: true });
  });
});
