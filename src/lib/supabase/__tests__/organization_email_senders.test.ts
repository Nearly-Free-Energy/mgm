/**
 * organization_email_senders.test.ts — RFC #186 PR 1, migration
 * 20261116210000.
 *
 * 1. A signed-in reader sees their own organization's sender, without the
 *    password column, and nothing of another organization's.
 * 2. Only the service role inserts or updates; signed-in callers may delete
 *    their own organization's row.
 * 3. A saved password stays with the server and username it was entered for,
 *    for every writer, the service role included.
 * 4. Only the service role reads the decrypted password.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();

const FIXTURE = {
  org: "e5e50000-aaaa-4000-8000-000000000001",
  orgOther: "e5e50000-bbbb-4000-8000-000000000001",
} as const;

const EMAILS = ["email-sender-mgr@test.local", "email-sender-outside@test.local"];
const PASSWORD = "smtp-test-password";

async function encrypt(plaintext: string): Promise<string> {
  const svc = await serviceClient();
  const { data, error } = await svc.rpc("fn_ems_encrypt_secret", { p_plaintext: plaintext });
  if (error || typeof data !== "string") throw new Error(`encrypt: ${error?.message}`);
  return data;
}

function senderRow(orgId: string, passwordEncrypted: string) {
  return {
    org_id: orgId,
    host: "smtp.example.com",
    port: 587,
    username: "notices@example.com",
    password_encrypted: passwordEncrypted,
    from_address: "notices@example.com",
  };
}

describe.skipIf(skip)("organization email senders (RFC #186)", () => {
  let MGR: TestUser;
  let OUTSIDE: TestUser;

  beforeAll(async () => {
    await assertEnvironmentReady();
    await cleanupTestData({ orgIds: [FIXTURE.org, FIXTURE.orgOther], userEmails: EMAILS });
    const svc = await serviceClient();
    await svc.from("organizations").upsert([
      { id: FIXTURE.org, name: "EmailSender Org" },
      { id: FIXTURE.orgOther, name: "EmailSender Other Org" },
    ]);
    MGR = await createTestUser({ email: EMAILS[0], role: "org_manager", scopeId: FIXTURE.org });
    OUTSIDE = await createTestUser({ email: EMAILS[1], role: "org_manager", scopeId: FIXTURE.orgOther });
  }, 60_000);

  beforeEach(async () => {
    const svc = await serviceClient();
    await svc.from("organization_email_senders").delete().in("org_id", [FIXTURE.org, FIXTURE.orgOther]);
    const { error } = await svc
      .from("organization_email_senders")
      .insert([senderRow(FIXTURE.org, await encrypt(PASSWORD)), senderRow(FIXTURE.orgOther, await encrypt(PASSWORD))]);
    expect(error).toBeNull();
  });

  afterAll(async () => {
    await cleanupTestData({ orgIds: [FIXTURE.org, FIXTURE.orgOther], userEmails: EMAILS });
  });

  it("shows an org manager their own organization's sender and not another's", async () => {
    const { data, error } = await MGR.client
      .from("organization_email_senders")
      .select("org_id, host, port, username, from_address, version")
      .in("org_id", [FIXTURE.org, FIXTURE.orgOther]);
    expect(error).toBeNull();
    expect(data?.map((row) => row.org_id)).toEqual([FIXTURE.org]);
  });

  it.each([
    ["the password column", "org_id, password_encrypted"],
    ["every column", "*"],
  ])("refuses a signed-in read of %s", async (_name, columns) => {
    const { data, error } = await MGR.client.from("organization_email_senders").select(columns).eq("org_id", FIXTURE.org);
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("refuses signed-in inserts and updates, even on the manager's own organization", async () => {
    const svc = await serviceClient();
    await svc.from("organization_email_senders").delete().eq("org_id", FIXTURE.org);
    const insert = await MGR.client.from("organization_email_senders").insert(senderRow(FIXTURE.org, await encrypt("x")));
    expect(insert.error?.code).toBe("42501");

    await svc.from("organization_email_senders").insert(senderRow(FIXTURE.org, await encrypt(PASSWORD)));
    const update = await MGR.client
      .from("organization_email_senders")
      .update({ from_address: "attacker@example.com" })
      .eq("org_id", FIXTURE.org);
    expect(update.error?.code).toBe("42501");
  });

  it("lets an org manager delete their own organization's sender, and only that one", async () => {
    await OUTSIDE.client.from("organization_email_senders").delete().eq("org_id", FIXTURE.org);
    const svc = await serviceClient();
    const { count: kept } = await svc
      .from("organization_email_senders")
      .select("org_id", { count: "exact", head: true })
      .eq("org_id", FIXTURE.org);
    expect(kept).toBe(1);

    const { error } = await MGR.client.from("organization_email_senders").delete().eq("org_id", FIXTURE.org);
    expect(error).toBeNull();
    const { count: left } = await svc
      .from("organization_email_senders")
      .select("org_id", { count: "exact", head: true })
      .eq("org_id", FIXTURE.org);
    expect(left).toBe(0);
  });

  it.each([
    ["host", { host: "mail.example.net" }],
    ["port", { port: 465 }],
    ["username", { username: "other@example.com" }],
  ])("refuses a %s change that keeps the saved password, even for the service role", async (_name, change) => {
    const svc = await serviceClient();
    const { error } = await svc.from("organization_email_senders").update(change).eq("org_id", FIXTURE.org);
    expect(error?.code).toBe("22023");
  });

  it("accepts a server change with a new password, and other changes without one", async () => {
    const svc = await serviceClient();
    const moved = await svc
      .from("organization_email_senders")
      .update({ host: "mail.example.net", password_encrypted: await encrypt("new-password") })
      .eq("org_id", FIXTURE.org);
    expect(moved.error).toBeNull();
    const renamed = await svc.from("organization_email_senders").update({ from_name: "Notices" }).eq("org_id", FIXTURE.org);
    expect(renamed.error).toBeNull();
  });

  it.each([
    ["port 25", { port: 25 }],
    ["an address literal", { host: "203.0.113.5" }],
    ["an upper-case host", { host: "SMTP.example.com" }],
    ["an unknown test status", { last_test_status: "maybe" }],
  ])("refuses %s", async (_name, change) => {
    const svc = await serviceClient();
    const { error } = await svc
      .from("organization_email_senders")
      .update({ ...change, password_encrypted: await encrypt(PASSWORD) })
      .eq("org_id", FIXTURE.org);
    expect(error?.code).toBe("23514");
  });

  const READ = { _org_id: FIXTURE.org, _version: 1, _host: "smtp.example.com", _port: 587, _username: "notices@example.com" };

  it("decrypts the saved password for the service role only", async () => {
    const svc = await serviceClient();
    const { data } = await svc.rpc("fn_organization_email_sender_password", READ);
    expect(data).toBe(PASSWORD);

    const { data: signedIn, error } = await MGR.client.rpc("fn_organization_email_sender_password", READ);
    expect(signedIn).toBeNull();
    expect(error?.code === "42501" || error?.code === "PGRST202" || error?.message?.toLowerCase().includes("permission denied")).toBe(true);
  });

  it("never decrypts a password saved for another server after the caller's read", async () => {
    // The race: a request reads version 1 at smtp.example.com, then another
    // admin saves a new server and password before it decrypts.
    const svc = await serviceClient();
    const moved = await svc
      .from("organization_email_senders")
      .update({ host: "attacker.example.net", password_encrypted: await encrypt("new-server-password"), version: 2 })
      .eq("org_id", FIXTURE.org);
    expect(moved.error).toBeNull();

    const { data, error } = await svc.rpc("fn_organization_email_sender_password", READ);
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it.each([
    ["version", { _version: 2 }],
    ["host", { _host: "mail.example.net" }],
    ["port", { _port: 465 }],
    ["username", { _username: "other@example.com" }],
  ])("returns nothing when the %s does not match the saved row", async (_name, change) => {
    const svc = await serviceClient();
    const { data, error } = await svc.rpc("fn_organization_email_sender_password", { ...READ, ...change });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("goes when its organization is deleted", async () => {
    const svc = await serviceClient();
    await svc.from("organizations").delete().eq("id", FIXTURE.orgOther);
    const { count } = await svc
      .from("organization_email_senders")
      .select("org_id", { count: "exact", head: true })
      .eq("org_id", FIXTURE.orgOther);
    expect(count).toBe(0);
    await svc.from("organizations").upsert({ id: FIXTURE.orgOther, name: "EmailSender Other Org" });
  });
});
