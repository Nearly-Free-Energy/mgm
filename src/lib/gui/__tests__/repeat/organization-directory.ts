/**
 * The twice-sent cases of the organization directory's "safe" actions
 * (../repeat.db.test.ts), with their fixture: one organization with a
 * manager and a second manager to remove, a super admin, an organization to
 * delete and one with a saved mail sender to remove. The people are made
 * with fixed ids, so the cases can name them in their paths. Each case is
 * sent as the person the action is offered to: a manager for the
 * organization's own settings, invitations and profile, a super admin for
 * what only a super admin may do or, today, can do.
 *
 * org.resend-invite and org.change-role are "unsafe" (a second send emails
 * again, or replaces the role row again), so they have no case here.
 *
 * No mail leaves the test. Saving a mail sender sends its test email
 * through runtime.mailTransports, which seed() replaces with a transport
 * that accepts every message without contacting anything, and cleanup()
 * restores. The invitation is the module's first case, sent while its
 * organization has no sender saved; ../repeat.db.test.ts blanks the
 * deployment's sender, so it answers email_sent: false, which its case
 * checks. If the cases are reordered or that test stops blanking the
 * deployment's sender, revisit.
 */
import { vi, type MockInstance } from "vitest";
import { TENANT_APP_PLUGIN_NAME } from "@/lib/plugins/bundled";
import type { MgmRuntime } from "@/lib/runtime/root";
import {
  cleanupTestData,
  clientAs,
  mintUserJwt,
  serviceClient,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";
import type { CaseModule, Fixture } from "./harness";

const ORG = "e2810000-0000-4000-8000-000000000001";
const DOOMED_ORG = "e2810000-0000-4000-8000-000000000002";
const SENDER_ORG = "e2810000-0000-4000-8000-000000000003";
const PEOPLE = {
  manager: { id: "e2810000-0000-4000-800b-000000000001", email: "repeat-od-manager@test.local" },
  superAdmin: { id: "e2810000-0000-4000-800b-000000000002", email: "repeat-od-super@test.local" },
  colleague: { id: "e2810000-0000-4000-800b-000000000003", email: "repeat-od-colleague@test.local" },
};
/** The address the invitation case invites; the route creates its account. */
const INVITEE = "repeat-od-invitee@test.local";
const NAMES = { doomed: "Repeat OD Doomed Org" };
const HOST = "smtp.example.com";

let transport: MockInstance | null = null;

/** A person with a fixed id and one staff row, signed in as themselves. */
async function person(who: { id: string; email: string }, role: "org_manager" | "super_admin", scopeId: string | null): Promise<TestUser> {
  const svc = await serviceClient();
  const made = await svc.auth.admin.createUser({ id: who.id, email: who.email, email_confirm: true });
  if (made.error) throw new Error(`[repeat organization-directory] ${who.email}: ${made.error.message}`);
  const { error } = await svc.from("user_roles").insert({ user_id: who.id, role, scope_type: "org", scope_id: scopeId });
  if (error) throw new Error(`[repeat organization-directory] user_roles for ${who.email}: ${error.message}`);
  const jwt = await mintUserJwt(who.id);
  return { userId: who.id, jwt, client: clientAs(jwt) };
}

export const ORGANIZATION_DIRECTORY_CASES: CaseModule = {
  cases: {
    // The address holds the access asked for now: 409 already_member, and
    // no second notice. First, so its organization has no sender yet.
    "org.invite-user": [
      {
        as: "manager",
        params: {},
        body: () => ({ email: INVITEE, first_name: "Ivy", last_name: "Repeat", phone: "", role: "org_manager", scope_id: ORG }),
        first: 201,
        firstAnswer: { existing_account: false, email_sent: false },
        second: 409,
      },
    ],
    // The same fields again: 200, the organization as it was.
    "org.update-organization": [
      {
        as: "superAdmin",
        params: { id: ORG },
        body: () => ({ name: "Repeat OD Org, renamed", address_city: "Jinja", address_line1: "" }),
        first: 200,
        second: 200,
      },
    ],
    // The organization is gone: 404.
    "org.delete-organization": [
      {
        as: "superAdmin",
        params: { id: DOOMED_ORG },
        body: () => ({ confirmation: { acknowledged: [], typed: NAMES.doomed } }),
        first: 204,
        second: 404,
      },
    ],
    // The first save moved the version from none to 1, so the same body,
    // which names none, answers 409 version_conflict before any test email.
    "org.save-email-sender": [
      {
        as: "manager",
        params: { id: ORG },
        body: () => ({
          host: HOST,
          port: 587,
          username: "notices",
          password: "repeat-od-password",
          fromAddress: "notices@example.com",
          fromName: "Repeat OD",
          replyTo: "",
          version: null,
        }),
        first: 200,
        second: 409,
      },
    ],
    // No sender is saved any more: 200 { sender: null }, deleting nothing.
    "org.remove-email-sender": [
      {
        as: "superAdmin",
        params: { id: SENDER_ORG },
        body: () => ({ confirmation: { acknowledged: [], typed: HOST } }),
        first: 200,
        second: 200,
      },
    ],
    // The plugin is in the state asked for: 200, and no second audit row.
    "org.set-plugin": [
      {
        as: "manager",
        params: { id: ORG },
        body: () => ({ plugin: TENANT_APP_PLUGIN_NAME, enabled: true }),
        first: 200,
        second: 200,
      },
    ],
    // The same fields again: 200, with only the profile's updated_at moved.
    "org.update-profile": [
      {
        as: "manager",
        params: { id: PEOPLE.manager.id },
        body: () => ({ first_name: "Repeat", last_name: "Manager", phone: "+256700281001" }),
        first: 200,
        second: 200,
        ignore: [
          {
            column: "user_profiles.updated_at",
            row: { user_id: PEOPLE.manager.id },
            reason: "A trigger stamps it on every update (00012_user_profiles.sql); the profile's fields are the same.",
          },
        ],
      },
    ],
    // The colleague holds no staff row now: the same 403 as anyone whose
    // access cannot be removed. Sent as a super admin: an org manager's
    // delete matches no row today (the user_roles SELECT policy shows a
    // manager only their own rows), so the route answers a manager 403.
    "org.remove-user": [
      {
        as: "superAdmin",
        params: { id: PEOPLE.colleague.id },
        body: () => ({ confirmation: { acknowledged: [], typed: PEOPLE.colleague.email } }),
        first: 204,
        second: 403,
      },
    ],
  },

  async cleanup() {
    transport?.mockRestore();
    transport = null;
    const svc = await serviceClient();
    const orgs = [ORG, DOOMED_ORG, SENDER_ORG];
    for (const table of ["mgm_plugins", "mgm_plugin_audit_log", "organization_email_senders"]) {
      const { error } = await svc.from(table).delete().in("org_id", orgs);
      if (error) throw new Error(`[repeat organization-directory] cleanup ${table}: ${error.message}`);
    }
    await cleanupTestData({ orgIds: orgs, userEmails: [...Object.values(PEOPLE).map((p) => p.email), INVITEE] });
  },

  async seed(runtime: MgmRuntime): Promise<Fixture> {
    transport = vi
      .spyOn(runtime.mailTransports, "create")
      .mockReturnValue({ send: async () => ({ ok: true as const, messageId: "<repeat-od@test.local>" }) });
    const svc = await serviceClient();
    const { error } = await svc.from("organizations").insert([
      { id: ORG, name: "Repeat OD Org", address_city: "Kampala", address_country: "Uganda" },
      { id: DOOMED_ORG, name: NAMES.doomed, address_city: "Kampala", address_country: "Uganda" },
      { id: SENDER_ORG, name: "Repeat OD Sender Org", address_city: "Kampala", address_country: "Uganda" },
    ]);
    if (error) throw new Error(`[repeat organization-directory] organizations: ${error.message}`);
    const { data: encrypted, error: encryptError } = await svc.rpc("fn_ems_encrypt_secret", { p_plaintext: "repeat-od-saved" });
    if (encryptError || !encrypted) throw new Error(`[repeat organization-directory] encrypt: ${encryptError?.message ?? "none"}`);
    const sender = await svc.from("organization_email_senders").insert({
      org_id: SENDER_ORG,
      host: HOST,
      port: 587,
      username: "notices",
      password_encrypted: encrypted,
      from_address: "notices@example.com",
    });
    if (sender.error) throw new Error(`[repeat organization-directory] organization_email_senders: ${sender.error.message}`);
    const manager = await person(PEOPLE.manager, "org_manager", ORG);
    await person(PEOPLE.colleague, "org_manager", ORG);
    const superAdmin = await person(PEOPLE.superAdmin, "super_admin", null);
    return { orgId: ORG, otherOrgIds: [DOOMED_ORG, SENDER_ORG], users: { manager, superAdmin } };
  },
};
