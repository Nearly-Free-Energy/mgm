/**
 * The organization directory's prepared actions against the local
 * database, as the GUI host prepares them (prepareAction) for a manager and
 * for a super admin, with the real runtime: who the `org.user` kind
 * resolves (a manager of an organization the caller reaches, through the
 * caller's own list, and no one else), each step's facts and what it asks to
 * type, and the refusals each shares with its route.
 *
 * Requires a running local Supabase (same harness as rls.test.ts).
 */
import type { User } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ceremony } from "@/lib/gui/contract";
import { createFmt } from "@/lib/gui/fmt";
import { hostContext } from "@/lib/gui/host/server/access";
import { prepareAction } from "@/lib/gui/host/server/prepare";
import { resetMgmRuntimeForTests } from "@/lib/runtime/root";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";
import type { UserRoleRecord } from "@/lib/types/domain";

const ORG = "e2811000-0000-4000-8000-000000000001";
const OTHER_ORG = "e2811000-0000-4000-8000-000000000002";
const OFF_ORG = "e2811000-0000-4000-8000-000000000003";
/** An organization holding a closed billing period, which the database keeps. */
const KEPT_ORG = "e2811000-0000-4000-8000-000000000004";
/** An organization whose name is blank: nothing to type. */
const BLANK_ORG = "e2811000-0000-4000-8000-000000000005";
const ALL_ORGS = [ORG, OTHER_ORG, OFF_ORG, KEPT_ORG, BLANK_ORG];
const COMMUNITY = "e2811000-0000-4000-8001-000000000001";
const MICROGRID = "e2811000-0000-4000-8002-000000000001";
const UNIT = "e2811000-0000-4000-8004-000000000001";
const KEPT_COMMUNITY = "e2811000-0000-4000-8001-000000000002";
const KEPT_MICROGRID = "e2811000-0000-4000-8002-000000000002";
const KEPT_SCHEDULE = "e2811000-0000-4000-8006-000000000001";
const CLOSED_PERIOD = "e2811000-0000-4000-8003-000000000001";
/** DELETE /api/users/[id]'s single refusal, which org.remove-user's prepare gives anyone but a super admin. */
const NOT_REVOKED = "No roles revoked (not authorized, or user has no roles).";
const EMAILS = {
  manager: "od-actions-manager@test.local",
  colleague: "od-actions-colleague@test.local",
  invited: "od-actions-invited@test.local",
  elsewhere: "od-actions-elsewhere@test.local",
  renter: "od-actions-renter@test.local",
  superAdmin: "od-actions-super@test.local",
};
const SAVED_PASSWORD = "od-actions-saved-password";

type Person = TestUser & { roles: UserRoleRecord[]; email: string };
let people: Record<Exclude<keyof typeof EMAILS, "invited">, Person>;
/** A manager invited to ORG who has not signed in: their address is not confirmed. */
let invitedId: string;

function ctx(who: Person) {
  const made = hostContext({ user: { id: who.userId, email: who.email } as User, roles: who.roles }, new Headers({ "accept-language": "en-GB" }), {
    newClient: async () => who.client,
    makeFmt: (locale) => createFmt({ locale }),
  });
  if (!made.ok) throw new Error("[od actions.db] context refused");
  return made.ctx;
}

async function prepare(who: Person, action: string, params: Record<string, string>, body?: Record<string, unknown>) {
  const out = await prepareAction(ctx(who), { action, params, ...(body ? { body } : {}) });
  if (!out.ok) return { ok: false as const, status: out.status, code: out.code, message: out.message };
  return { ok: true as const, ceremony: out.value.ceremony as Ceremony, confirm: out.value.confirm, tone: out.value.tone };
}
const factsOf = (c: Ceremony) => Object.fromEntries(c.facts.map((f) => [f.label, (f.value as { text?: string }).text]));

async function cleanup() {
  const svc = await serviceClient();
  await svc.from("mgm_plugins").delete().in("org_id", ALL_ORGS);
  await svc.from("organization_email_senders").delete().in("org_id", ALL_ORGS);
  await cleanupTestData({ orgIds: ALL_ORGS, userEmails: Object.values(EMAILS) });
}

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();
  await cleanup();
  const svc = await serviceClient();
  const orgs = await svc.from("organizations").insert([
    { id: ORG, name: "OD Actions Org" },
    { id: OTHER_ORG, name: "OD Actions Other Org" },
    { id: OFF_ORG, name: "OD Actions Off Org" },
    { id: KEPT_ORG, name: "OD Actions Kept Org" },
    { id: BLANK_ORG, name: "   " },
  ]);
  if (orgs.error) throw new Error(`[od actions.db] organizations: ${orgs.error.message}`);
  const off = await svc.from("mgm_plugins").insert({ org_id: OFF_ORG, plugin_name: "community-management", version: "0.1.0", enabled: false });
  if (off.error) throw new Error(`[od actions.db] mgm_plugins: ${off.error.message}`);
  const { data: encrypted } = await svc.rpc("fn_ems_encrypt_secret", { p_plaintext: SAVED_PASSWORD });
  const sender = await svc.from("organization_email_senders").insert({
    org_id: OTHER_ORG,
    host: "smtp.example.com",
    port: 587,
    username: "notices",
    password_encrypted: encrypted,
    from_address: "notices@example.com",
  });
  if (sender.error) throw new Error(`[od actions.db] organization_email_senders: ${sender.error.message}`);

  const made = async (key: keyof typeof EMAILS, role: "org_manager" | "super_admin" | "tenant" | null, scopeId: string | null) => {
    const user = await createTestUser({ email: EMAILS[key], role, scopeId });
    const { data } = await svc.from("user_roles").select("*").eq("user_id", user.userId);
    return { ...user, email: EMAILS[key], roles: (data ?? []) as UserRoleRecord[] };
  };
  const renter = await made("renter", null, null);
  // A unit for the renter, so their only row is a tenant row.
  const rows: [string, Record<string, unknown>][] = [
    ["communities", { id: COMMUNITY, org_id: ORG, name: "OD Actions Community" }],
    ["microgrids", { id: MICROGRID, community_id: COMMUNITY, name: "OD Actions Site", currency: "UGX", timezone: "Africa/Kampala" }],
    ["tenants", { id: UNIT, microgrid_id: MICROGRID, display_name: "OD Actions Unit", primary_phone: "+256700281501" }],
    // A closed billing period under KEPT_ORG.
    ["communities", { id: KEPT_COMMUNITY, org_id: KEPT_ORG, name: "OD Actions Kept Community" }],
    ["microgrids", { id: KEPT_MICROGRID, community_id: KEPT_COMMUNITY, name: "OD Actions Kept Site", currency: "UGX", timezone: "Africa/Kampala" }],
    [
      "rate_schedules",
      { id: KEPT_SCHEDULE, microgrid_id: KEPT_MICROGRID, tiers: [{ label: "Flat", min_kwh: 1, max_kwh: null, rate_per_kwh: 500 }], service_charge: 0, tax_rate: 0 },
    ],
    [
      "billing_periods",
      {
        id: CLOSED_PERIOD,
        microgrid_id: KEPT_MICROGRID,
        start_date: "2026-09-01",
        end_date: "2026-09-30",
        timezone: "Africa/Kampala",
        status: "closed",
        closed_at: "2026-10-02T09:00:00Z",
        rate_schedule_id: KEPT_SCHEDULE,
      },
    ],
  ];
  for (const [table, value] of rows) {
    const { error } = await svc.from(table).insert(value);
    if (error) throw new Error(`[od actions.db] ${table}: ${error.message}`);
  }
  const tenantRow = await svc.from("user_roles").insert({ user_id: renter.userId, role: "tenant", scope_type: "tenant", scope_id: UNIT });
  if (tenantRow.error) throw new Error(`[od actions.db] tenant row: ${tenantRow.error.message}`);
  people = {
    manager: await made("manager", "org_manager", ORG),
    colleague: await made("colleague", "org_manager", ORG),
    elsewhere: await made("elsewhere", "org_manager", OTHER_ORG),
    renter,
    superAdmin: await made("superAdmin", "super_admin", null),
  };
  // An invitation not yet accepted, as the invite route makes one: an account
  // whose address is not confirmed, with its role.
  const invited = await svc.auth.admin.createUser({ email: EMAILS.invited, email_confirm: false });
  if (invited.error || !invited.data.user) throw new Error(`[od actions.db] invited: ${invited.error?.message}`);
  invitedId = invited.data.user.id;
  const invitedRole = await svc.from("user_roles").insert({ user_id: invitedId, role: "org_manager", scope_type: "org", scope_id: ORG });
  if (invitedRole.error) throw new Error(`[od actions.db] invited role: ${invitedRole.error.message}`);
}, 120_000);

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanup();
  resetMgmRuntimeForTests();
}, 120_000);

describe.skipIf(shouldSkip())("the organization directory's actions, prepared against the database", () => {
  it("resolves a person only as a manager of an organization the caller reaches, through the caller's own list", async () => {
    const { manager, superAdmin } = people;
    // A colleague in the manager's organization resolves (an invitation not
    // yet accepted, so the resend's step is offered); someone managing
    // another organization, a person whose rows are all tenant rows, a super
    // admin and no one at all are the same 404.
    expect(await prepare(manager, "org.resend-invite", { id: invitedId })).toMatchObject({ ok: true });
    for (const id of [people.elsewhere.userId, people.renter.userId, superAdmin.userId, "e2811000-0000-4000-800b-0000000000ff"]) {
      expect(await prepare(manager, "org.resend-invite", { id }), id).toMatchObject({ ok: false, status: 404, code: "gui_not_found" });
    }
    // A super admin reaches every organization's managers, and still no
    // super admin or tenant (the gap the follow-up issue names).
    expect(await prepare(superAdmin, "org.remove-user", { id: people.elsewhere.userId })).toMatchObject({ ok: true });
    for (const id of [superAdmin.userId, people.renter.userId]) {
      expect(await prepare(superAdmin, "org.remove-user", { id }), id).toMatchObject({ ok: false, status: 404 });
    }
  });

  it("asks a super admin for the person's address, typed, to remove them, and refuses an org manager with the route's 403", async () => {
    const step = await prepare(people.superAdmin, "org.remove-user", { id: people.colleague.userId });
    expect(step).toMatchObject({ ok: true, confirm: "typed", tone: "danger" });
    if (step.ok) {
      expect(step.ceremony.typed).toBe(EMAILS.colleague);
      expect(factsOf(step.ceremony)).toEqual({ "Email address": EMAILS.colleague, Role: "Org manager, OD Actions Org" });
    }
    // The route removes no one for an org manager (the user_roles SELECT
    // policy shows them only their own rows), so the step is refused with
    // its answer, for a colleague and for themselves alike.
    for (const id of [people.colleague.userId, people.manager.userId]) {
      expect(await prepare(people.manager, "org.remove-user", { id }), id).toMatchObject({ ok: false, status: 403, message: NOT_REVOKED });
    }
  });

  it("resends only an invitation not yet accepted, naming the address", async () => {
    const step = await prepare(people.manager, "org.resend-invite", { id: invitedId });
    expect(step).toMatchObject({ ok: true, confirm: "confirm" });
    if (step.ok) expect(step.ceremony.statement).toContain(EMAILS.invited);
    expect(await prepare(people.manager, "org.resend-invite", { id: people.colleague.userId })).toMatchObject({
      ok: false,
      status: 409,
      message: "User has already accepted their invitation.",
    });
  });

  it("refuses a role change to anyone but a super admin before reading the person, and to a super admin for themselves", async () => {
    expect(await prepare(people.manager, "org.change-role", { id: people.colleague.userId })).toMatchObject({
      ok: false,
      status: 403,
      message: "Only super admins can change roles.",
    });
    const step = await prepare(people.superAdmin, "org.change-role", { id: people.colleague.userId }, { role: "org_manager", scope_id: OTHER_ORG });
    expect(step).toMatchObject({ ok: true, confirm: "ceremony", tone: "neutral" });
    if (step.ok) {
      expect(factsOf(step.ceremony)).toMatchObject({ "Role now": "Org manager, OD Actions Org", "New role": "Org manager, OD Actions Other Org" });
      expect(step.ceremony.typed).toBeUndefined();
      expect(step.ceremony.acknowledgements).toEqual([]);
    }
  });

  it("asks a super admin for the organization's name to delete it, with what goes with it, and refuses everyone else", async () => {
    const step = await prepare(people.superAdmin, "org.delete-organization", { id: ORG });
    expect(step).toMatchObject({ ok: true, confirm: "typed", tone: "danger" });
    if (step.ok) {
      expect(step.ceremony.typed).toBe("OD Actions Org");
      expect(factsOf(step.ceremony)).toMatchObject({ Organization: "OD Actions Org", Communities: "1", Tenants: "1" });
    }
    expect(await prepare(people.manager, "org.delete-organization", { id: ORG })).toMatchObject({
      ok: false,
      status: 403,
      message: "You do not have permission to delete this organization.",
    });
    expect(await prepare(people.superAdmin, "org.delete-organization", { id: OFF_ORG })).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses deleting an organization that holds closed billing, or whose name is blank, with the route's copy", async () => {
    expect(await prepare(people.superAdmin, "org.delete-organization", { id: KEPT_ORG })).toMatchObject({
      ok: false,
      status: 409,
      message:
        "This organization has 1 closed billing period. Closed billing and billing with recorded payments are kept, so this organization cannot be deleted.",
    });
    expect(await prepare(people.superAdmin, "org.delete-organization", { id: BLANK_ORG })).toMatchObject({
      ok: false,
      status: 409,
      message: "Unnamed entity cannot be typed-to-confirm.",
    });
  });

  it("names the saved mail server to remove it, without its password, and refuses when none is saved", async () => {
    const step = await prepare(people.elsewhere, "org.remove-email-sender", { id: OTHER_ORG });
    expect(step).toMatchObject({ ok: true, confirm: "typed" });
    if (step.ok) expect(step.ceremony.typed).toBe("smtp.example.com");
    expect(JSON.stringify(step)).not.toContain(SAVED_PASSWORD);
    expect(await prepare(people.manager, "org.remove-email-sender", { id: ORG })).toMatchObject({
      ok: false,
      status: 404,
      message: "No email settings are saved for this organization.",
    });
  });

  it("sends a sender's test email to the caller's own address, and never takes a password into the step", async () => {
    const step = await prepare(people.manager, "org.save-email-sender", { id: ORG }, { host: "smtp.example.com", password: "typed-secret" });
    expect(step).toMatchObject({ ok: true, confirm: "confirm" });
    if (step.ok) expect(factsOf(step.ceremony)).toEqual({ Organization: "OD Actions Org", "Test email to": EMAILS.manager, "Mail server": "smtp.example.com" });
    expect(JSON.stringify(step)).not.toContain("typed-secret");
  });

  it("offers an invitation to the organization the action is bound to, reading no address", async () => {
    const step = await prepare(people.manager, "org.invite-user", { scope_id: ORG });
    expect(step).toMatchObject({ ok: true, confirm: "confirm" });
    if (step.ok) expect(factsOf(step.ceremony)).toEqual({ Organization: "OD Actions Org" });
    expect(await prepare(people.manager, "org.invite-user", { scope_id: OTHER_ORG })).toMatchObject({ ok: false, status: 404 });
  });
});
