/**
 * tenant_access.test.ts — the tenant role against a real database
 * (RFC mgm#197, PR 1: migrations 20261118100000 and 20261118100100; PR 2:
 * 20261118140000; the shared-use days, 20261120090000).
 *
 * A tenant is someone who rents a unit on a microgrid. Their access is a
 * user_roles row (user_id, 'tenant', 'tenant', tenants.id). This suite
 * proves what that row lets its holder read, that it lets them read nothing
 * staff-only, and how organization managers give and remove it. From PR 2
 * it also proves the tenant-app plugin's state (off for an organization
 * until a row turns it on), the record of accounts that have held staff
 * access, and that tenant access does not depend on staff rows: the grant
 * gives units to staff and former staff alike, a tenant whose staff row is
 * removed is a tenant like any other (rows kept, given further units, off
 * the Users page), and the record keeps an account left with no rows on
 * the Users page once it has been staff. "Staff" means holding a role other
 * than tenant now (src/lib/roles.ts).
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
 * cross-organization manager, with one tenant, OTHER, on its microgrid and
 * edge, whose meter is DEVICE_OTHER, so one person can rent units in two
 * organizations.
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
 *   microgridOnly — an ems_operator row and nothing else, created and
 *                  removed by one invitation test, so the staff record
 *                  (staff_access_accounts, history that outlives rows) never
 *                  names noRole
 * and, created by the staff-record tests (after the access tests, so the
 * counts above do not move):
 *   formerStaff  — org manager of the organization, whose row is removed;
 *                  listed with no rows, then given B and left off
 *   emsTenant    — tenant of B who also gets an ems_operator row
 *   madeStaff    — tenant of B who is made org manager, loses it, and is
 *                  then given A like any tenant
 *   fresh        — no rows; given access to B
 *   rejoined     — tenant of B, made org manager and removed through the
 *                  Users page's own query, given A, then revoked from both
 *   twoUnits     — no rows; given A and OTHER, each by its organization's
 *                  manager, then loses OTHER
 * Within that block the tests run in order and share these accounts, so
 * each one's expectations depend on what the tests above it did. The lock
 * tests at the end of the file each create their own account and stand
 * alone:
 *   locked       — no rows; given B while its auth.users row is locked,
 *                  then revoked
 *   removed      — no rows; soft-deleted while a grant to B waits on its
 *                  row, then restored for afterAll
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  LOCAL_SUPABASE_URL,
  raceAgainstHeldTransaction,
  runAsDatabaseOwner,
  serviceClient,
  shouldSkip,
  testAnonKey,
  type TestUser,
} from "./rls.helpers";
import { countEntityDescendants } from "@/lib/entity-descendants";
import {
  MGM_BUNDLED_PLUGINS,
  OPERATIONS_PLUGIN_NAME,
  TENANT_APP_PLUGIN_NAME,
  TENANT_APP_PLUGIN_VERSION,
  isEnabledByDefault,
} from "@/lib/plugins/bundled";
import { resolveTargetOrganization } from "@/lib/runtime/gate";
import { createSupabaseTenantAppRepository } from "@/lib/tenant-app/infrastructure/supabase-repository";

const F = {
  org: "7e4a0000-0000-4000-8000-000000000001",
  otherOrg: "7e4a0000-0000-4000-8000-000000000002",
  community: "7e4a0000-0000-4000-8001-000000000001",
  otherCommunity: "7e4a0000-0000-4000-8001-000000000002",
  microgrid: "7e4a0000-0000-4000-8002-000000000001",
  otherMicrogrid: "7e4a0000-0000-4000-8002-000000000002",
  edge: "7e4a0000-0000-4000-8003-000000000001",
  otherEdge: "7e4a0000-0000-4000-8003-000000000002",
  deviceA: "7e4a0000-0000-4000-8004-000000000001",
  deviceMoved: "7e4a0000-0000-4000-8004-000000000002",
  deviceB: "7e4a0000-0000-4000-8004-000000000003",
  deviceShared: "7e4a0000-0000-4000-8004-000000000004",
  deviceOther: "7e4a0000-0000-4000-8004-000000000005",
  tenantA: "7e4a0000-0000-4000-8005-000000000001",
  tenantB: "7e4a0000-0000-4000-8005-000000000002",
  tenantC: "7e4a0000-0000-4000-8005-000000000003",
  tenantOther: "7e4a0000-0000-4000-8005-000000000004",
  period: "7e4a0000-0000-4000-8006-000000000001",
  lineItem: "7e4a0000-0000-4000-8007-000000000001",
  merchant: "7e4a0000-0000-4000-8008-000000000001",
  attempt: "7e4a0000-0000-4000-8009-000000000001",
  unknown: "7e4a0000-0000-4000-80ff-000000000001",
  client: "7e4a0000-0000-4000-800a-000000000001",
};
/** The fixture's own keys in the staff tables that have no organization column. */
const SIGN_IN_HASH = "7e4a".repeat(16);
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
  microgridOnly: "tenant-access-microgrid-only@test.local",
  formerStaff: "tenant-access-former-staff@test.local",
  emsTenant: "tenant-access-ems-tenant@test.local",
  madeStaff: "tenant-access-made-staff@test.local",
  fresh: "tenant-access-fresh@test.local",
  rejoined: "tenant-access-rejoined@test.local",
  twoUnits: "tenant-access-two-units@test.local",
  locked: "tenant-access-locked@test.local",
  removed: "tenant-access-removed@test.local",
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
    // Its approval records go with it.
    ["mgm_clients", () => svc.from("mgm_clients").delete().eq("client_id", F.client)],
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
    { id: F.otherEdge, microgrid_id: F.otherMicrogrid, name: "Tenant access other edge", openems_edge_id: "tenant-access-other-edge" },
  ]);
  await insert(svc, "devices", [
    { id: F.deviceA, edge_id: F.edge, name: "Meter A", device_type: "consumption_meter", openems_component_id: "meter10" },
    { id: F.deviceMoved, edge_id: F.edge, name: "Meter moved", device_type: "consumption_meter", openems_component_id: "meter11" },
    { id: F.deviceB, edge_id: F.edge, name: "Meter B", device_type: "consumption_meter", openems_component_id: "meter12" },
    { id: F.deviceShared, edge_id: F.edge, name: "Shared meter", device_type: "consumption_meter", openems_component_id: "meter13" },
    { id: F.deviceOther, edge_id: F.otherEdge, name: "Meter other", device_type: "consumption_meter", openems_component_id: "meter10" },
  ]);
  await insert(svc, "tenants", [
    { id: F.tenantA, microgrid_id: F.microgrid, display_name: "Unit A", unit_label: "A1", primary_phone: "+256700000101", geography_notes: "staff note" },
    { id: F.tenantB, microgrid_id: F.microgrid, display_name: "Unit B", unit_label: "B1", primary_phone: "+256700000102" },
    { id: F.tenantC, microgrid_id: F.microgrid, display_name: "Unit C", unit_label: "C1", primary_phone: "+256700000103" },
    // The same display name as A: one person's units carry their own name.
    { id: F.tenantOther, microgrid_id: F.otherMicrogrid, display_name: "Unit A", unit_label: "O1", primary_phone: "+256700000104" },
  ]);
  await insert(svc, "tenant_devices", [
    { tenant_id: F.tenantA, device_id: F.deviceA, role: "primary_consumption_meter", effective_from: "2026-04-01" },
    { tenant_id: F.tenantA, device_id: F.deviceMoved, role: "primary_consumption_meter", effective_from: "2026-01-01", effective_to: "2026-04-01" },
    { tenant_id: F.tenantB, device_id: F.deviceMoved, role: "primary_consumption_meter", effective_from: "2026-04-01" },
    { tenant_id: F.tenantB, device_id: F.deviceB, role: "secondary_meter", effective_from: "2026-01-01" },
    { tenant_id: F.tenantOther, device_id: F.deviceOther, role: "primary_consumption_meter", effective_from: "2026-01-01" },
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
  // A client and the tenant's own approval of it: neither is theirs to read.
  await insert(svc, "mgm_clients", [{ client_id: F.client, kind: "operator", label: "Tenant access client" }]);
  await insert(svc, "mgm_client_approvals", [{ user_id: tenantOnly.userId, client_id: F.client }]);
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
    mgm_client_approvals: `client_id = '${F.client}'`,
    mgm_clients: `client_id = '${F.client}'`,
    mgm_plugin_audit_log: `org_id = '${F.org}'`,
    mgm_plugins: `org_id = '${F.org}'`,
    microgrid_recent_activity: `microgrid_id = '${F.microgrid}'`,
    microgrid_savings_settings: `microgrid_id = '${F.microgrid}'`,
    microgrid_shared_devices: `microgrid_id = '${F.microgrid}'`,
    microgrids: `id = '${F.microgrid}'`,
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
    staff_access_accounts: `user_id = '${manager.userId}'`,
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
  it("cannot change their tenant row, its assignments, their devices, or what a meter is", async () => {
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
    // The tenant app counts a unit's use by the device type, the edge and
    // component it reads, and the link's role and dates. The fixture tenant
    // sees only consumption meters, so re-typing Meter A away from one shows
    // the column cannot be written at all.
    for (const patch of [
      { openems_component_id: "meter99" },
      { device_type: "grid_meter" as const },
      { edge_id: F.otherEdge },
    ]) {
      const changed = await tenantOnly.client.from("devices").update(patch).eq("id", F.deviceA).select();
      expect(changed.data ?? [], JSON.stringify(patch)).toEqual([]);
    }
    const relinked = await tenantOnly.client
      .from("tenant_devices")
      .update({ role: "secondary_meter", effective_from: "2026-01-01", effective_to: "2026-02-01" })
      .eq("tenant_id", F.tenantA)
      .eq("device_id", F.deviceA)
      .select();
    expect(relinked.data ?? []).toEqual([]);
    const created = await tenantOnly.client
      .from("devices")
      .insert({ edge_id: F.edge, name: "Rogue", device_type: "consumption_meter", openems_component_id: "meter99" });
    expectDenied(created.error);

    const tenant = await svc.from("tenants").select("display_name").eq("id", F.tenantA).single();
    expect(tenant.data?.display_name).toBe("Unit A");
    const links = await svc.from("tenant_devices").select("id").eq("tenant_id", F.tenantA);
    expect(links.data).toHaveLength(2);
    const device = await svc
      .from("devices")
      .select("name, device_type, edge_id, openems_component_id")
      .eq("id", F.deviceA)
      .single();
    expect(device.data).toEqual({
      name: "Meter A",
      device_type: "consumption_meter",
      edge_id: F.edge,
      openems_component_id: "meter10",
    });
    const link = await svc
      .from("tenant_devices")
      .select("role, effective_from, effective_to")
      .eq("tenant_id", F.tenantA)
      .eq("device_id", F.deviceA)
      .single();
    expect(link.data).toEqual({ role: "primary_consumption_meter", effective_from: "2026-04-01", effective_to: null });
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

  // user_is_tenant_of_device ignores effective dates on purpose
  // (20261118140000 § 6): the tenant app shows the days a meter was a
  // tenant's, including those before it moved away. So a former tenant reads
  // every column above of that meter's device row, which is safe only while
  // each of them is one a former tenant may read.
  it("a former tenant of a meter that moved away reads exactly these devices columns of it", async () => {
    const links = await tenantOnly.client
      .from("tenant_devices")
      .select("tenant_id, effective_to")
      .eq("device_id", F.deviceMoved);
    expect(links.error).toBeNull();
    // Only their own, ended assignment: B's current one stays invisible.
    expect(links.data).toEqual([{ tenant_id: F.tenantA, effective_to: "2026-04-01" }]);

    const { data, error } = await tenantOnly.client.from("devices").select("*").eq("id", F.deviceMoved);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(Object.keys(data![0]).sort()).toEqual(TENANT_READABLE.devices);
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

// ── fn_tenant_shared_meter_days ───────────────────────────────────────────

desc("fn_tenant_shared_meter_days", () => {
  const ask = (client: SupabaseClient, tenantId: string, toDate = "2026-05-01") =>
    client.rpc("fn_tenant_shared_meter_days", { _tenant_id: tenantId, _from_date: "2026-03-01", _to_date: toDate });

  it("refuses the unit's own tenant while the tenant app is off for its organization", async () => {
    // The fixture has no tenant-app row for the organization, so it is off.
    const { data, error } = await ask(tenantOnly.client, F.tenantA);
    expectCode(error, "42501");
    expect(data).toBeNull();
  });

  describe("with the tenant app on for the organization", () => {
    beforeAll(async () => {
      if (skip) return;
      const svc = await serviceClient();
      const { error } = await svc
        .from("mgm_plugins")
        .insert({ org_id: F.org, plugin_name: TENANT_APP_PLUGIN_NAME, version: TENANT_APP_PLUGIN_VERSION, enabled: true });
      if (error) throw new Error(`[tenant_access] tenant-app on: ${error.message}`);
    });

    // "the tenant-app plugin's state" below expects no row for the organization.
    afterAll(async () => {
      if (skip) return;
      const svc = await serviceClient();
      const { error } = await svc.from("mgm_plugins").delete().eq("org_id", F.org).eq("plugin_name", TENANT_APP_PLUGIN_NAME);
      if (error) throw new Error(`[tenant_access] tenant-app off: ${error.message}`);
    });

    it("answers the unit's own tenant, with no day where links only abut", async () => {
      // DEVICE_MOVED was A's primary until 04-01 and is B's from 04-01:
      // half-open links that abut share no day. This pins the boundary only
      // together with the positive cases in usage.db.test.ts, which prove
      // the function returns spans at all.
      const { data, error } = await ask(tenantOnly.client, F.tenantA);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("answers a manager who also rents for their own unit", async () => {
      const { error } = await ask(dual.client, F.tenantA);
      expect(error).toBeNull();
    });

    it("refuses a manager of the organization who rents other units for a unit they do not rent", async () => {
      const { data, error } = await ask(dual.client, F.tenantB);
      expectCode(error, "42501");
      expect(data).toBeNull();
    });

    it("refuses staff, another unit's tenant, an unknown unit and an account with no role", async () => {
      for (const [label, client, tenant] of [
        ["manager", manager.client, F.tenantA],
        ["superAdmin", superAdmin.client, F.tenantA],
        ["otherManager", otherManager.client, F.tenantA],
        ["tenantOnly for B", tenantOnly.client, F.tenantB],
        ["tenantOnly for OTHER", tenantOnly.client, F.tenantOther],
        ["tenantOnly for an unknown unit", tenantOnly.client, F.unknown],
        ["noRole", noRole.client, F.tenantA],
      ] as const) {
        const { data, error } = await ask(client, tenant);
        expect(error?.code, label).toBe("42501");
        expect(data, label).toBeNull();
      }
    });

    it("rejects a range that does not end", async () => {
      expectCode((await ask(tenantOnly.client, F.tenantA, "infinity")).error, "22023");
    });
  });

  it("is a SECURITY DEFINER, STABLE function with a pinned search_path", () => {
    const [row] = ownerRows<{ prosecdef: boolean; provolatile: string; config: string | null }>(
      `SELECT prosecdef, provolatile, array_to_string(proconfig, ';') AS config
         FROM pg_proc
        WHERE oid = 'public.fn_tenant_shared_meter_days(uuid, date, date)'::regprocedure`,
    );
    expect(row.prosecdef).toBe(true);
    expect(row.provolatile).toBe("s");
    expect(row.config?.split(";")).toContain("search_path=public, pg_temp");
  });
});

// ── The tenant-app plugin (PR 2) ──────────────────────────────────────────

desc("the tenant-app plugin's state", () => {
  const enabledFor = async (client: SupabaseClient, orgId: string, plugin: string): Promise<boolean> => {
    const { data, error } = await client.rpc("mgm_plugin_enabled_for_org", { _org_id: orgId, _plugin_name: plugin });
    expect(error, plugin).toBeNull();
    return data as boolean;
  };
  const setTenantApp = (client: SupabaseClient, enabled: boolean) =>
    client.rpc("fn_mgm_set_plugin_enabled", {
      _org_id: F.org,
      _plugin_name: TENANT_APP_PLUGIN_NAME,
      _plugin_version: TENANT_APP_PLUGIN_VERSION,
      _enabled: enabled,
    });

  // default-off-plugins.test.ts compares the migration text with the
  // catalog; this asks the database itself.
  it("answers each bundled plugin's catalog default when the organization has no row: tenant-app and operations off, the rest on", async () => {
    const svc = await serviceClient();
    const rows = await svc.from("mgm_plugins").select("plugin_name").eq("org_id", F.otherOrg);
    expect(rows.data).toEqual([]);
    const answers: Record<string, boolean> = {};
    for (const plugin of MGM_BUNDLED_PLUGINS) answers[plugin.name] = await enabledFor(svc, F.otherOrg, plugin.name);
    expect(answers).toEqual(
      Object.fromEntries(MGM_BUNDLED_PLUGINS.map((plugin) => [plugin.name, isEnabledByDefault(plugin)])),
    );
    expect(answers[TENANT_APP_PLUGIN_NAME]).toBe(false);
    expect(answers[OPERATIONS_PLUGIN_NAME]).toBe(false);
    expect(Object.values(answers).filter((on) => !on)).toHaveLength(2);
  });

  it("is off for the tenant's organization until its manager turns it on; the tenant cannot", async () => {
    const svc = await serviceClient();
    // The organization has a billing row and none for tenant-app.
    for (const client of [svc, manager.client, tenantOnly.client]) {
      expect(await enabledFor(client, F.org, TENANT_APP_PLUGIN_NAME)).toBe(false);
    }

    expectCode((await setTenantApp(tenantOnly.client, true)).error, "42501");
    expectCode((await setTenantApp(otherManager.client, true)).error, "42501");
    expect(await enabledFor(tenantOnly.client, F.org, TENANT_APP_PLUGIN_NAME)).toBe(false);

    const on = await setTenantApp(manager.client, true);
    expect(on.error).toBeNull();
    expect(on.data).toMatchObject({
      org_id: F.org,
      plugin_name: TENANT_APP_PLUGIN_NAME,
      version: TENANT_APP_PLUGIN_VERSION,
      enabled: true,
    });
    // The composer asks with the tenant's own token (composeTenantApp → checkGate).
    expect(await enabledFor(tenantOnly.client, F.org, TENANT_APP_PLUGIN_NAME)).toBe(true);
    expect(await enabledFor(manager.client, F.org, TENANT_APP_PLUGIN_NAME)).toBe(true);
    // Per organization: the other one is still off. A tenant may ask about
    // any organization id, theirs or not (20261118140000 § 2): the answer
    // is the plugin's state, not access.
    expect(await enabledFor(tenantOnly.client, F.otherOrg, TENANT_APP_PLUGIN_NAME)).toBe(false);

    const off = await setTenantApp(manager.client, false);
    expect(off.error).toBeNull();
    expect(await enabledFor(tenantOnly.client, F.org, TENANT_APP_PLUGIN_NAME)).toBe(false);

    const audit = await svc
      .from("mgm_plugin_audit_log")
      .select("action, previous_enabled, new_enabled, actor_user_id")
      .eq("org_id", F.org)
      .eq("plugin_name", TENANT_APP_PLUGIN_NAME)
      .order("created_at");
    expect(audit.error).toBeNull();
    expect(audit.data).toEqual([
      { action: "enabled", previous_enabled: null, new_enabled: true, actor_user_id: manager.userId },
      { action: "disabled", previous_enabled: true, new_enabled: false, actor_user_id: manager.userId },
    ]);

    // Left on for the rest of the suite, as an operator would.
    expect((await setTenantApp(manager.client, true)).error).toBeNull();
  });

  it("carries a comment naming tenant-only accounts among its callers", () => {
    const [row] = ownerRows<{ comment: string | null }>(
      "SELECT obj_description('public.mgm_plugin_enabled_for_org(uuid, text)'::regprocedure, 'pg_proc') AS comment",
    );
    expect(row.comment).toContain("tenant-only accounts");
    expect(row.comment).toContain("not an access check");
  });

  it("the plugin-name CHECKs and fn_mgm_set_plugin_enabled still refuse a name that is not a plugin, the alias included", async () => {
    const svc = await serviceClient();
    const row = await svc
      .from("mgm_plugins")
      .insert({ org_id: F.otherOrg, plugin_name: "tenant", version: TENANT_APP_PLUGIN_VERSION, enabled: true });
    expectCode(row.error, "23514");
    const audit = await svc
      .from("mgm_plugin_audit_log")
      .insert({ org_id: F.otherOrg, plugin_name: "tenant", action: "enabled", new_enabled: true });
    expectCode(audit.error, "23514");
    const set = await manager.client.rpc("fn_mgm_set_plugin_enabled", {
      _org_id: F.org,
      _plugin_name: "tenant",
      _plugin_version: TENANT_APP_PLUGIN_VERSION,
      _enabled: true,
    });
    expectCode(set.error, "P0001");
  });

  it("the tenant app's meter read runs under the tenant's own token, clipped to the day", async () => {
    const repository = createSupabaseTenantAppRepository(tenantOnly.client);
    expect(await repository.listMetersInForce(F.tenantA, "2026-05-01")).toEqual([
      {
        deviceId: F.deviceA,
        name: "Meter A",
        deviceType: "consumption_meter",
        role: "primary_consumption_meter",
        effectiveFrom: "2026-04-01",
        effectiveTo: null,
      },
    ]);
    // Half-open periods: the moved meter was A's up to the day before the move.
    expect((await repository.listMetersInForce(F.tenantA, "2026-03-31")).map((m) => m.deviceId)).toEqual([
      F.deviceMoved,
    ]);
    expect((await repository.listMetersInForce(F.tenantA, "2026-04-01")).map((m) => m.deviceId)).toEqual([
      F.deviceA,
    ]);
    // Another unit's meters are not the tenant's to list.
    expect(await repository.listMetersInForce(F.tenantB, "2026-05-01")).toEqual([]);
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

  // 20261119150000: an invitation is for an account with no role row of any
  // scope. A tenant row and a microgrid-scoped row each count.
  it("fn_finalize_user_invitation refuses an account holding only a tenant row, or only a microgrid row", async () => {
    const svc = await serviceClient();
    const snapshot = async (userId: string) => {
      const roles = await svc.from("user_roles").select("role, scope_type, scope_id").eq("user_id", userId).order("role");
      const profile = await svc.from("user_profiles").select("first_name, last_name, phone").eq("user_id", userId).single();
      return { roles: roles.data, profile: profile.data };
    };
    const invite = (client: typeof manager.client, userId: string) =>
      client.rpc("fn_finalize_user_invitation", {
        p_user_id: userId,
        p_first_name: "Over",
        p_last_name: "Written",
        p_phone: "+256700000009",
        p_role: "org_manager",
        p_scope_id: F.org,
      });

    // An account of its own: the staff record keeps any account that ever
    // held a row other than tenant (20261118140000), and the staff-record
    // tests below expect noRole never to have held one.
    const microgridOnly = await createTestUser({ email: EMAIL.microgridOnly, role: null });
    try {
      const { error: insErr } = await svc
        .from("user_roles")
        .insert({ user_id: microgridOnly.userId, role: "ems_operator", scope_type: "microgrid", scope_id: F.microgrid });
      expect(insErr).toBeNull();
      for (const target of [tenantOnly.userId, microgridOnly.userId]) {
        const before = await snapshot(target);
        for (const caller of [manager.client, superAdmin.client]) {
          expectCode((await invite(caller, target)).error, "42501");
        }
        expect(await snapshot(target)).toEqual(before);
      }
    } finally {
      await svc.auth.admin.deleteUser(microgridOnly.userId);
    }
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
    // removed, but was a tenant and never staff: decision 5 keeps them off
    // the list (an account that has been staff is listed, below).
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

// ── Staff accounts, the tenant grant and the Users page (PR 2) ────────────

/** The migration whose staff_access_accounts backfill the tests below replay. */
const STAFF_RECORD_MIGRATION = "20261118140000_tenant_app_plugin.sql";

desc("staff_access_accounts, the tenant grant and the Users page", () => {
  let formerStaff: TestUser;
  let emsTenant: TestUser;
  let madeStaff: TestUser;
  let fresh: TestUser;
  let rejoined: TestUser;

  const grant = async (tenantId: string, userId: string, actor: string) => {
    const svc = await serviceClient();
    return svc.rpc("fn_tenant_access_grant", { _tenant_id: tenantId, _user_id: userId, _actor: actor });
  };
  const idList = (ids: string[]) => ids.map((id) => `'${id}'`).join(", ");
  /** Which of these accounts staff_access_accounts holds, sorted. */
  const recorded = (ids: string[]): string[] =>
    ownerRows<{ user_id: string }>(
      `SELECT user_id FROM public.staff_access_accounts WHERE user_id IN (${idList(ids)}) ORDER BY user_id`,
    ).map((r) => r.user_id);
  /** The Users page's rows for these accounts, as a super admin sees them, sorted. */
  const listed = async (ids: string[]) => {
    const { data, error } = await superAdmin.client.rpc("fn_list_visible_users", { _target_user_ids: ids });
    expect(error).toBeNull();
    return (data as { user_id: string; role: string | null; ems_operator_count: number }[])
      .map((r) => ({ user_id: r.user_id, role: r.role, ems_operator_count: r.ems_operator_count }))
      .sort((a, b) => a.user_id.localeCompare(b.user_id));
  };
  /** Exactly DELETE /api/users/[id]'s query, with the caller's own client. */
  const removeStaffAccess = (client: SupabaseClient, userId: string) =>
    client.from("user_roles").delete({ count: "exact" }).eq("user_id", userId).neq("role", "tenant");
  const tenantRowsOf = async (userId: string) => {
    const svc = await serviceClient();
    const { data, error } = await svc
      .from("user_roles")
      .select("id, scope_id")
      .eq("user_id", userId)
      .eq("role", "tenant")
      .order("scope_id");
    expect(error).toBeNull();
    return data ?? [];
  };

  beforeAll(async () => {
    [formerStaff, emsTenant, madeStaff, fresh, rejoined] = await Promise.all([
      createTestUser({ email: EMAIL.formerStaff, role: "org_manager", scopeId: F.org }),
      createTestUser({ email: EMAIL.emsTenant, role: "tenant", scopeType: "tenant", scopeId: F.tenantB }),
      createTestUser({ email: EMAIL.madeStaff, role: "tenant", scopeType: "tenant", scopeId: F.tenantB }),
      createTestUser({ email: EMAIL.fresh, role: null }),
      createTestUser({ email: EMAIL.rejoined, role: "tenant", scopeType: "tenant", scopeId: F.tenantB }),
    ]);
  }, 60_000);

  it("records every account holding a staff row, and no account that has only held tenant rows or none", () => {
    const [unrecorded] = ownerRows<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.user_roles ur
        WHERE ur.role <> 'tenant'
          AND NOT EXISTS (SELECT 1 FROM public.staff_access_accounts s WHERE s.user_id = ur.user_id)`,
    );
    expect(unrecorded.n, "staff rows whose account the record misses").toBe(0);

    const staff = [manager, otherManager, superAdmin, dual, formerStaff].map((u) => u.userId);
    expect(recorded(staff)).toEqual([...staff].sort());
    // noRole and fresh have no rows; the trigger records nothing for them.
    const notStaff = [tenantOnly, tenantOfC, noRole, grantee, emsTenant, madeStaff, fresh, rejoined].map(
      (u) => u.userId,
    );
    expect(recorded(notStaff)).toEqual([]);
  });

  it("the trigger records an ems_operator row and a staff row given to a tenant, and the record outlives the rows", async () => {
    const svc = await serviceClient();
    // ems_operator is microgrid-scoped staff (the CHECK pairs them); none
    // ship, but a row of one is staff, not a tenant.
    const ems = await svc
      .from("user_roles")
      .insert({ user_id: emsTenant.userId, role: "ems_operator", scope_type: "microgrid", scope_id: F.microgrid });
    expect(ems.error).toBeNull();
    // A tenant made org manager, as a super admin's invitation of their
    // address would (fn_change_user_role adds the row).
    const made = await svc
      .from("user_roles")
      .insert({ user_id: madeStaff.userId, role: "org_manager", scope_type: "org", scope_id: F.org });
    expect(made.error).toBeNull();
    expect(recorded([emsTenant.userId, madeStaff.userId])).toEqual([emsTenant.userId, madeStaff.userId].sort());

    // Their staff access is removed by a super admin, through DELETE
    // /api/users/[id]'s own query, so the delete guard and RLS run as there.
    const madeStaffTenantRows = await tenantRowsOf(madeStaff.userId);
    for (const user of [madeStaff, formerStaff]) {
      const removed = await removeStaffAccess(superAdmin.client, user.userId);
      expect(removed.error).toBeNull();
      expect(removed.count).toBe(1);
    }
    const left = await svc.from("user_roles").select("user_id, role").in("user_id", [madeStaff.userId, formerStaff.userId]);
    expect(left.data).toEqual([{ user_id: madeStaff.userId, role: "tenant" }]);
    expect(await tenantRowsOf(madeStaff.userId)).toEqual(madeStaffTenantRows);
    expect(recorded([madeStaff.userId, formerStaff.userId])).toEqual([madeStaff.userId, formerStaff.userId].sort());
  });

  it("the backfill records holders of a staff row and accounts with no row that never held a tenant row, and no one else", () => {
    // The migration's own backfill statements, replayed in a transaction
    // that is rolled back by the exception carrying the result, against a
    // record emptied of these accounts first.
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", STAFF_RECORD_MIGRATION), "utf8");
    const backfill = sql.match(/INSERT INTO public\.staff_access_accounts \(user_id\)\s+SELECT[\s\S]*?;/g) ?? [];
    expect(backfill, "the migration's two backfill statements").toHaveLength(2);

    // manager and dual hold staff rows; noRole has no row and was never a
    // tenant; tenantOnly holds a tenant row; grantee is a former tenant with
    // no row (its access was revoked above).
    const ids = [manager, dual, noRole, tenantOnly, grantee].map((u) => u.userId);
    const result = runAsDatabaseOwner(
      [
        "DO $backfill$",
        "DECLARE r text;",
        "BEGIN",
        `  DELETE FROM public.staff_access_accounts WHERE user_id IN (${idList(ids)});`,
        ...backfill.map((statement) => `  ${statement}`),
        `  SELECT string_agg(user_id::text, ',' ORDER BY user_id) INTO r FROM public.staff_access_accounts WHERE user_id IN (${idList(ids)});`,
        "  RAISE EXCEPTION 'backfill-result:%:end', coalesce(r, '');",
        "END",
        "$backfill$",
      ].join("\n"),
    );
    expect(result.ok).toBe(false);
    const match = /backfill-result:([^:]*):end/.exec(result.output);
    expect(match, result.output).not.toBeNull();
    expect(match![1].split(",").filter(Boolean)).toEqual([manager.userId, dual.userId, noRole.userId].sort());
    // Rolled back: noRole is still not recorded, manager still is.
    expect(recorded([noRole.userId, manager.userId])).toEqual([manager.userId]);
  });

  it("the grant gives a unit to current staff, who then hold both and stay listed as staff", async () => {
    for (const user of [superAdmin, manager]) {
      const { data, error } = await grant(F.tenantB, user.userId, manager.userId);
      expect(error).toBeNull();
      expect(typeof data).toBe("string");
      const home = await user.client.rpc("fn_tenant_home", { _tenant_id: F.tenantB });
      expect(home.error).toBeNull();
      expect((home.data as { tenant_id: string }[]).map((r) => r.tenant_id)).toEqual([F.tenantB]);
    }
    expect(await listed([superAdmin.userId, manager.userId])).toEqual(
      [
        { user_id: superAdmin.userId, role: "super_admin", ems_operator_count: 0 },
        { user_id: manager.userId, role: "org_manager", ems_operator_count: 0 },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
  });

  it("the grant gives a tenant whose org_manager row was removed another unit, like any tenant", async () => {
    const before = await tenantRowsOf(madeStaff.userId);
    expect(before.map((r) => r.scope_id)).toEqual([F.tenantB]);
    const { data, error } = await grant(F.tenantA, madeStaff.userId, manager.userId);
    expect(error).toBeNull();
    expect(typeof data).toBe("string");

    const reads = await madeStaff.client.from("tenants").select("id");
    expect((reads.data ?? []).map((r) => r.id).sort()).toEqual([F.tenantA, F.tenantB].sort());
    // Their first unit's row is the same row, not a new one.
    expect(await tenantRowsOf(madeStaff.userId)).toEqual(expect.arrayContaining(before));
    // The record is history and stays; it no longer counts while they hold rows.
    expect(recorded([madeStaff.userId])).toEqual([madeStaff.userId]);
  });

  it("the grant gives an account that has never been staff access, without recording it as staff", async () => {
    const first = await grant(F.tenantB, fresh.userId, manager.userId);
    expect(first.error).toBeNull();
    expect(typeof first.data).toBe("string");
    const { data } = await fresh.client.from("tenants").select("id");
    expect((data ?? []).map((r) => r.id)).toEqual([F.tenantB]);
    expect(recorded([fresh.userId])).toEqual([]);
  });

  it("the Users page lists staff now and accounts with no rows that were staff, and leaves out anyone holding tenant rows and no staff row", async () => {
    expect(await listed([emsTenant, madeStaff, formerStaff, fresh, tenantOnly, grantee].map((u) => u.userId))).toEqual(
      [
        // Holds an ems_operator row and a tenant row.
        { user_id: emsTenant.userId, role: null, ems_operator_count: 1 },
        // Staff access removed, never a tenant, no rows: listed as before.
        { user_id: formerStaff.userId, role: null, ems_operator_count: 0 },
      ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
    // Left out: madeStaff, a tenant once made org manager and then removed,
    // who now holds only tenant rows; fresh and tenantOnly, tenants never
    // staff; grantee, a former tenant with no rows who was never staff.
  });

  it("the grant gives a former staff account with no rows a unit, and the Users page then leaves it out", async () => {
    expect(await listed([formerStaff.userId])).toEqual([
      { user_id: formerStaff.userId, role: null, ems_operator_count: 0 },
    ]);
    const { error } = await grant(F.tenantB, formerStaff.userId, manager.userId);
    expect(error).toBeNull();
    const { data } = await formerStaff.client.from("tenants").select("id");
    expect((data ?? []).map((r) => r.id)).toEqual([F.tenantB]);
    expect(await listed([formerStaff.userId])).toEqual([]);
  });

  it("a tenant made org manager and removed through the Users page is a tenant again, until their last unit goes", async () => {
    const svc = await serviceClient();
    const before = await tenantRowsOf(rejoined.userId);
    expect(before.map((r) => r.scope_id)).toEqual([F.tenantB]);

    // Made org manager, as a super admin's invitation of their address adds the row.
    const made = await svc
      .from("user_roles")
      .insert({ user_id: rejoined.userId, role: "org_manager", scope_type: "org", scope_id: F.org });
    expect(made.error).toBeNull();
    expect(await listed([rejoined.userId])).toEqual([
      { user_id: rejoined.userId, role: "org_manager", ems_operator_count: 0 },
    ]);

    // Removed by a super admin with exactly DELETE /api/users/[id]'s query.
    const removed = await removeStaffAccess(superAdmin.client, rejoined.userId);
    expect(removed.error).toBeNull();
    expect(removed.count).toBe(1);
    expect(await tenantRowsOf(rejoined.userId)).toEqual(before);
    const target = await svc.rpc("fn_auth_sign_in_target", { _email: EMAIL.rejoined });
    expect(target.data).toBe(rejoined.userId);

    // Given another unit like any tenant, and left off the Users page whether
    // it asks for everyone or names them.
    const granted = await grant(F.tenantA, rejoined.userId, manager.userId);
    expect(granted.error).toBeNull();
    const after = await tenantRowsOf(rejoined.userId);
    expect(after.map((r) => r.scope_id).sort()).toEqual([F.tenantA, F.tenantB].sort());
    expect(after).toEqual(expect.arrayContaining(before));
    expect(await listed([rejoined.userId])).toEqual([]);
    const everyone = await superAdmin.client.rpc("fn_list_visible_users");
    expect(everyone.error).toBeNull();
    expect((everyone.data as { user_id: string }[]).map((r) => r.user_id)).not.toContain(rejoined.userId);

    // Every unit revoked: no rows left, and listed again, with no role,
    // because the account has been staff.
    for (const unit of [F.tenantA, F.tenantB]) {
      const access = await accessIdOf(unit, EMAIL.rejoined);
      const revoked = await manager.client.rpc("fn_tenant_access_revoke", { _tenant_id: unit, _access_id: access });
      expect(revoked.error).toBeNull();
    }
    expect(await tenantRowsOf(rejoined.userId)).toEqual([]);
    expect(await listed([rejoined.userId])).toEqual([
      { user_id: rejoined.userId, role: null, ems_operator_count: 0 },
    ]);
  });
});

// ── Several units (PR 2) ──────────────────────────────────────────────────

desc("a tenant with units in two organizations", () => {
  let twoUnits: TestUser;

  beforeAll(async () => {
    twoUnits = await createTestUser({ email: EMAIL.twoUnits, role: null });
  }, 60_000);

  const grant = async (tenantId: string, actor: string) => {
    const svc = await serviceClient();
    return svc.rpc("fn_tenant_access_grant", { _tenant_id: tenantId, _user_id: twoUnits.userId, _actor: actor });
  };

  it("is given a unit by each organization's own manager, and by neither for the other's", async () => {
    expectCode((await grant(F.tenantOther, manager.userId)).error, "42501");
    expectCode((await grant(F.tenantA, otherManager.userId)).error, "42501");
    expect((await grant(F.tenantA, manager.userId)).error).toBeNull();
    expect((await grant(F.tenantOther, otherManager.userId)).error).toBeNull();
  });

  it("reads both units, their meter assignments and their meters, and nothing else", async () => {
    const tenants = await twoUnits.client.from("tenants").select("id");
    expect((tenants.data ?? []).map((r) => r.id).sort()).toEqual([F.tenantA, F.tenantOther].sort());
    const links = await twoUnits.client.from("tenant_devices").select("tenant_id, device_id");
    expect((links.data ?? []).map((r) => `${r.tenant_id}:${r.device_id}`).sort()).toEqual(
      [`${F.tenantA}:${F.deviceA}`, `${F.tenantA}:${F.deviceMoved}`, `${F.tenantOther}:${F.deviceOther}`].sort(),
    );
    const devices = await twoUnits.client.from("devices").select("id");
    expect((devices.data ?? []).map((r) => r.id).sort()).toEqual([F.deviceA, F.deviceMoved, F.deviceOther].sort());
  });

  it("fn_tenant_home answers each unit with its own organization", async () => {
    for (const [unit, organization, microgrid] of [
      [F.tenantA, F.org, F.microgrid],
      [F.tenantOther, F.otherOrg, F.otherMicrogrid],
    ] as const) {
      const { data, error } = await twoUnits.client.rpc("fn_tenant_home", { _tenant_id: unit });
      expect(error).toBeNull();
      expect(data).toEqual([expect.objectContaining({ tenant_id: unit, organization_id: organization, microgrid_id: microgrid })]);
    }
  });

  it("the tenant app's meter read lists each unit's own meter only", async () => {
    const repository = createSupabaseTenantAppRepository(twoUnits.client);
    expect((await repository.listMetersInForce(F.tenantA, "2026-05-01")).map((m) => m.deviceId)).toEqual([F.deviceA]);
    expect((await repository.listMetersInForce(F.tenantOther, "2026-05-01")).map((m) => m.deviceId)).toEqual([
      F.deviceOther,
    ]);
  });

  it("losing one unit keeps the other and the person's sessions", async () => {
    addSession(twoUnits.userId);
    const listed = await otherManager.client.rpc("fn_tenant_access_list", { _tenant_id: F.tenantOther });
    expect(listed.error).toBeNull();
    const access = (listed.data as { access_id: string; email: string }[]).find((r) => r.email === EMAIL.twoUnits);
    expect(access).toBeDefined();
    const { data, error } = await otherManager.client.rpc("fn_tenant_access_revoke", {
      _tenant_id: F.tenantOther,
      _access_id: access!.access_id,
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
    expect(sessionCount(twoUnits.userId)).toEqual({ sessions: 1, tokens: 1 });

    const tenants = await twoUnits.client.from("tenants").select("id");
    expect((tenants.data ?? []).map((r) => r.id)).toEqual([F.tenantA]);
    const home = await twoUnits.client.rpc("fn_tenant_home", { _tenant_id: F.tenantOther });
    expect(home.data).toEqual([]);
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

desc("anon is denied every new or re-issued function", () => {
  const CALLS: [string, Record<string, unknown>][] = [
    ["user_can_access_tenant", { _tenant_id: F.tenantA }],
    ["user_is_tenant_of_device", { _device_id: F.deviceA }],
    ["fn_tenant_home", { _tenant_id: F.tenantA }],
    ["fn_tenant_shared_meter_days", { _tenant_id: F.tenantA, _from_date: "2026-11-01", _to_date: "2026-12-01" }],
    ["fn_tenant_access_grant", { _tenant_id: F.tenantA, _user_id: F.unknown, _actor: F.unknown }],
    ["fn_tenant_access_revoke", { _tenant_id: F.tenantA, _access_id: F.unknown }],
    ["fn_tenant_access_list", { _tenant_id: F.tenantA }],
    ["fn_tenant_access_count", { _tenant_ids: [F.tenantA] }],
    // Re-issued by 20261118140000.
    ["mgm_plugin_enabled_for_org", { _org_id: F.org, _plugin_name: TENANT_APP_PLUGIN_NAME }],
    [
      "fn_mgm_set_plugin_enabled",
      { _org_id: F.org, _plugin_name: TENANT_APP_PLUGIN_NAME, _plugin_version: TENANT_APP_PLUGIN_VERSION, _enabled: true },
    ],
    ["fn_list_visible_users", {}],
  ];

  // Through PostgREST, the grant layer must be what refuses: the access
  // functions raise 42501 themselves for a caller without a session, which
  // would pass a looser check with anon's EXECUTE granted.
  it.each(CALLS)("anon cannot call %s", async (fn, args) => {
    const { error } = await anonClient().rpc(fn, args);
    expectAnonDenied(error);
    expectGrantLayerDenied(error);
  });

  it("the grants themselves: no EXECUTE for anon on any, and the grant and trigger functions for the service role only", () => {
    const rows = ownerRows<{ signature: string; anon: boolean; authenticated: boolean; service_role: boolean }>(
      `SELECT s AS signature,
              has_function_privilege('anon', s, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', s, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', s, 'EXECUTE') AS service_role
         FROM unnest(ARRAY[
           'public.user_can_access_tenant(uuid)',
           'public.user_is_tenant_of_device(uuid)',
           'public.fn_tenant_home(uuid)',
           'public.fn_tenant_shared_meter_days(uuid, date, date)',
           'public.fn_tenant_access_grant(uuid, uuid, uuid)',
           'public.fn_tenant_access_revoke(uuid, uuid)',
           'public.fn_tenant_access_list(uuid)',
           'public.fn_tenant_access_count(uuid[])',
           'public.fn_user_roles_record_tenant_account()',
           'public.mgm_plugin_enabled_for_org(uuid, text)',
           'public.fn_mgm_set_plugin_enabled(uuid, text, text, boolean)',
           'public.fn_list_visible_users(uuid[])',
           'public.fn_user_roles_record_staff_account()'
         ]) AS s`,
    );
    const both = { anon: false, authenticated: true, service_role: true };
    const serviceOnly = { anon: false, authenticated: false, service_role: true };
    expect(rows).toEqual([
      { signature: "public.user_can_access_tenant(uuid)", ...both },
      { signature: "public.user_is_tenant_of_device(uuid)", ...both },
      { signature: "public.fn_tenant_home(uuid)", ...both },
      { signature: "public.fn_tenant_shared_meter_days(uuid, date, date)", ...both },
      { signature: "public.fn_tenant_access_grant(uuid, uuid, uuid)", ...serviceOnly },
      { signature: "public.fn_tenant_access_revoke(uuid, uuid)", ...both },
      { signature: "public.fn_tenant_access_list(uuid)", ...both },
      { signature: "public.fn_tenant_access_count(uuid[])", ...both },
      { signature: "public.fn_user_roles_record_tenant_account()", ...serviceOnly },
      { signature: "public.mgm_plugin_enabled_for_org(uuid, text)", ...both },
      { signature: "public.fn_mgm_set_plugin_enabled(uuid, text, text, boolean)", ...both },
      { signature: "public.fn_list_visible_users(uuid[])", ...both },
      { signature: "public.fn_user_roles_record_staff_account()", ...serviceOnly },
    ]);
  });

  it("tenant_access_accounts and staff_access_accounts are closed to the API roles", () => {
    const rows = ownerRows<{ name: string; anon: boolean; authenticated: boolean; rls: boolean }>(
      `SELECT t AS name,
              has_table_privilege('anon', t, 'SELECT') AS anon,
              has_table_privilege('authenticated', t, 'SELECT') AS authenticated,
              (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) AS rls
         FROM unnest(ARRAY['public.tenant_access_accounts', 'public.staff_access_accounts']) AS t`,
    );
    expect(rows).toEqual([
      { name: "public.tenant_access_accounts", anon: false, authenticated: false, rls: true },
      { name: "public.staff_access_accounts", anon: false, authenticated: false, rls: true },
    ]);
  });
});

// ── The grant's row lock (PR 2 review) ────────────────────────────────────

desc("fn_tenant_access_grant locks the account", () => {
  it("waits for a transaction holding the account's auth.users row, then grants", async () => {
    // The holder takes the lock the grant takes (FOR NO KEY UPDATE) and
    // commits only once another backend waits on it. The grant's foreign key
    // check takes only FOR KEY SHARE, which does not wait on it, so the grant
    // waits only because it takes the lock itself; without it, the holder
    // fails after 30 seconds with "nothing waited on this transaction".
    const locked = await createTestUser({ email: EMAIL.locked, role: null });
    const svc = await serviceClient();
    const race = await raceAgainstHeldTransaction(
      `  PERFORM 1 FROM auth.users WHERE id = '${locked.userId}' FOR NO KEY UPDATE;`,
      () => svc.rpc("fn_tenant_access_grant", { _tenant_id: F.tenantB, _user_id: locked.userId, _actor: manager.userId }),
    );
    expect(race.holder.ok, race.holder.output).toBe(true);
    expect(race.contender.error).toBeNull();
    expect(race.contender.data).toBe(await accessIdOf(F.tenantB, EMAIL.locked));

    // Leave tenant B's access as the tests above left it.
    const revoked = await manager.client.rpc("fn_tenant_access_revoke", {
      _tenant_id: F.tenantB,
      _access_id: race.contender.data,
    });
    expect(revoked.error).toBeNull();
  }, 60_000);

  it("checks the account again once it holds the lock: one removed while the grant waited is not found", async () => {
    // The holder soft-deletes the account, an UPDATE that holds the row lock
    // the grant asks for. Once it commits, the grant reads the row again and
    // finds no live account, so it refuses rather than granting to it.
    const removed = await createTestUser({ email: EMAIL.removed, role: null });
    const svc = await serviceClient();
    try {
      const race = await raceAgainstHeldTransaction(
        `  UPDATE auth.users SET deleted_at = now() WHERE id = '${removed.userId}';`,
        () => svc.rpc("fn_tenant_access_grant", { _tenant_id: F.tenantB, _user_id: removed.userId, _actor: manager.userId }),
      );
      expect(race.holder.ok, race.holder.output).toBe(true);
      expect(race.contender.error?.code).toBe("P0002");
      expect(race.contender.error?.message).toBe("User not found.");
      const rows = await svc.from("user_roles").select("id").eq("user_id", removed.userId);
      expect(rows.error).toBeNull();
      expect(rows.data).toEqual([]);
    } finally {
      // Live again, so afterAll removes it like every other account here.
      const restored = runAsDatabaseOwner(`UPDATE auth.users SET deleted_at = NULL WHERE id = '${removed.userId}'`);
      expect(restored.ok, restored.output).toBe(true);
    }
  }, 60_000);
});
