/**
 * email_notices.test.ts — RFC #186 § 5, PR 3: which server sends a notice.
 *
 * Runs sendNotice against the local database with recording transports:
 *   1. an organization's saved sender sends it, with the decrypted password;
 *   2. when that server fails, the deployment's sender sends it (decision
 *      2) and the failure is flagged on the saved settings, saying whether
 *      the fallback delivered it; a later notice that gets through clears
 *      the flag;
 *   3. an organization without a sender, or no organization, uses the
 *      deployment's sender (decision 1);
 *   4. without a deployment sender, the notice is not sent.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertEnvironmentReady, cleanupTestData, serviceClient, shouldSkip } from "./rls.helpers";
import { sendNotice } from "@/lib/email/notices";
import { MailTransportRegistry } from "@/lib/runtime/services";
import type { MailMessage, MailSendResult, SmtpSenderSettings } from "@/lib/email/types";

const skip = shouldSkip();
const ORG = "e1e10000-aaaa-4000-8000-000000000001";
const ORG_WITHOUT = "e1e10000-bbbb-4000-8000-000000000001";
const PASSWORD = "notice-sender-password";
const MESSAGE: MailMessage = { to: "invitee@test.local", subject: "You have access", text: "Hello" };

type Sent = { settings: SmtpSenderSettings; message: MailMessage };

function transports(orgResult: () => MailSendResult) {
  const sent: Sent[] = [];
  const registry = new MailTransportRegistry();
  registry.register("smtp", (settings) => ({
    send: async (message) => {
      sent.push({ settings, message });
      return settings.host === "smtp.org.example" ? orgResult() : { ok: true, messageId: null };
    },
  }));
  return { registry, sent };
}

describe.skipIf(skip)("notices (RFC #186 § 5)", () => {
  beforeAll(async () => {
    await assertEnvironmentReady();
    await cleanupTestData({ orgIds: [ORG, ORG_WITHOUT], userEmails: [] });
    const svc = await serviceClient();
    await svc.from("organizations").upsert([
      { id: ORG, name: "Notice Org" },
      { id: ORG_WITHOUT, name: "Notice Org Without Sender" },
    ]);
  }, 60_000);

  beforeEach(async () => {
    vi.stubEnv("MGM_SMTP_URL", "smtps://mgm:pw@smtp.deployment.example:465");
    vi.stubEnv("MGM_MAIL_FROM", "MGM <no-reply@deployment.example>");
    const svc = await serviceClient();
    await svc.from("organization_email_senders").delete().eq("org_id", ORG);
    const { data: encrypted } = await svc.rpc("fn_ems_encrypt_secret", { p_plaintext: PASSWORD });
    const { error } = await svc.from("organization_email_senders").insert({
      org_id: ORG,
      host: "smtp.org.example",
      port: 587,
      username: "notices@org.example",
      password_encrypted: encrypted,
      from_address: "notices@org.example",
      last_test_status: "success",
    });
    expect(error).toBeNull();
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    await cleanupTestData({ orgIds: [ORG, ORG_WITHOUT], userEmails: [] });
  });

  const savedStatus = async () => {
    const svc = await serviceClient();
    const { data } = await svc
      .from("organization_email_senders")
      .select("last_test_status, last_test_message, version")
      .eq("org_id", ORG)
      .single<{ last_test_status: string; last_test_message: string | null; version: number }>();
    return data!;
  };

  it("sends through the organization's saved server, with its password", async () => {
    const { registry, sent } = transports(() => ({ ok: true, messageId: null }));
    const result = await sendNotice({ service: await serviceClient(), transports: registry, orgId: ORG, message: MESSAGE });
    expect(result).toEqual({ ok: true, via: "organization" });
    expect(sent).toHaveLength(1);
    expect(sent[0].settings).toMatchObject({ host: "smtp.org.example", password: PASSWORD, fromAddress: "notices@org.example" });
  });

  it("flags a failing organization server and falls back to the deployment's, then clears the flag", async () => {
    let orgWorks = false;
    const { registry, sent } = transports(() =>
      orgWorks ? { ok: true, messageId: null } : { ok: false, reason: "auth_failed", message: "The mail server refused the username or password." }
    );
    const svc = await serviceClient();

    const failed = await sendNotice({ service: svc, transports: registry, orgId: ORG, message: MESSAGE });
    expect(failed).toEqual({ ok: true, via: "deployment" });
    expect(sent.map((s) => s.settings.host)).toEqual(["smtp.org.example", "smtp.deployment.example"]);
    const flagged = await savedStatus();
    expect(flagged.last_test_status).toBe("auth_failed");
    expect(flagged.last_test_message).toContain("MGM's own mail server sent it instead");
    // Flagging does not count as a settings change.
    expect(flagged.version).toBe(1);

    orgWorks = true;
    expect(await sendNotice({ service: svc, transports: registry, orgId: ORG, message: MESSAGE })).toEqual({
      ok: true,
      via: "organization",
    });
    expect((await savedStatus()).last_test_status).toBe("success");
  });

  it("says the notice was not delivered when the fallback fails too", async () => {
    vi.stubEnv("MGM_SMTP_URL", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry } = transports(() => ({ ok: false, reason: "unreachable", message: "Could not connect." }));
    const result = await sendNotice({ service: await serviceClient(), transports: registry, orgId: ORG, message: MESSAGE });
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    const flagged = await savedStatus();
    expect(flagged.last_test_status).toBe("unreachable");
    expect(flagged.last_test_message).toContain("could not send it either, so it was not delivered");
    expect(flagged.last_test_message).not.toContain("sent it instead");
    error.mockRestore();
  });

  it.each([
    ["an organization without a sender", ORG_WITHOUT],
    ["no organization", null],
  ])("sends for %s through the deployment's server", async (_name, orgId) => {
    const { registry, sent } = transports(() => ({ ok: true, messageId: null }));
    const result = await sendNotice({ service: await serviceClient(), transports: registry, orgId, message: MESSAGE });
    expect(result).toEqual({ ok: true, via: "deployment" });
    expect(sent.map((s) => s.settings.host)).toEqual(["smtp.deployment.example"]);
  });

  it("sends nothing when there is no organization sender and no deployment sender", async () => {
    vi.stubEnv("MGM_SMTP_URL", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, sent } = transports(() => ({ ok: true, messageId: null }));
    const result = await sendNotice({ service: await serviceClient(), transports: registry, orgId: ORG_WITHOUT, message: MESSAGE });
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(sent).toHaveLength(0);
    expect(JSON.stringify(error.mock.calls)).toContain("MGM_SMTP_URL");
    error.mockRestore();
  });
});
