/**
 * auth_sign_in_requests.test.ts — RFC #186 PR 2, migration 20261117030000.
 *
 * 1. Link requests: 1 a minute and 5 an hour per address, 20 an hour per IP.
 * 2. fn_auth_sign_in_target finds only people with an MGM role.
 * 3. Only the service role reaches any of it.
 * 4. End to end against the local Supabase: issueSignInLink sends a link
 *    (no code), the link signs in once, and a second link cancels the first.
 *
 * Opt-out: SKIP_RLS_TESTS=1, for running without a local Supabase.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import {
  LOCAL_SUPABASE_URL,
  assertEnvironmentReady,
  cleanupTestData,
  createTestUser,
  serviceClient,
  shouldSkip,
  testAnonKey,
  type TestUser,
} from "./rls.helpers";
import { hashForLimit, issueSignInLink } from "@/lib/auth/sign-in-link";
import { MailTransportRegistry } from "@/lib/runtime/services";
import type { MailMessage } from "@/lib/email/types";

const skip = shouldSkip();
const ORG = "a5a50000-aaaa-4000-8000-000000000001";
const EMAILS = ["sign-in-mgr@test.local", "sign-in-norole@test.local"];
const IP = hashForLimit("198.51.100.77");

async function rows(svc: Awaited<ReturnType<typeof serviceClient>>, emailHash: string) {
  await svc.from("auth_sign_in_requests").delete().eq("email_hash", emailHash);
}

describe.skipIf(skip)("sign-in requests (RFC #186)", () => {
  let MGR: TestUser;
  let noRoleId: string;

  beforeAll(async () => {
    await assertEnvironmentReady();
    await cleanupTestData({ orgIds: [ORG], userEmails: EMAILS });
    const svc = await serviceClient();
    await svc.from("organizations").upsert({ id: ORG, name: "SignIn Org" });
    MGR = await createTestUser({ email: EMAILS[0], role: "org_manager", scopeId: ORG });
    const { data, error } = await svc.auth.admin.createUser({ email: EMAILS[1], email_confirm: true });
    if (error) throw error;
    noRoleId = data.user.id;
  }, 60_000);

  beforeEach(async () => {
    const svc = await serviceClient();
    await svc.from("auth_sign_in_requests").delete().eq("ip_hash", IP);
    for (const email of EMAILS) await rows(svc, hashForLimit(email));
  });

  afterAll(async () => {
    const svc = await serviceClient();
    await svc.from("auth_sign_in_requests").delete().eq("ip_hash", IP);
    for (const email of EMAILS) await rows(svc, hashForLimit(email));
    await cleanupTestData({ orgIds: [ORG], userEmails: EMAILS });
    if (noRoleId) await svc.auth.admin.deleteUser(noRoleId);
  });

  const claim = async (email: string, ip: string | null = IP) => {
    const svc = await serviceClient();
    const { data, error } = await svc.rpc("fn_auth_claim_sign_in_request", { _email_hash: hashForLimit(email), _ip_hash: ip });
    expect(error).toBeNull();
    return data;
  };

  it("allows one link a minute per address", async () => {
    expect(await claim("limit-a@test.local")).toEqual(expect.any(Number));
    expect(await claim("limit-a@test.local")).toBeNull();
    await rows(await serviceClient(), hashForLimit("limit-a@test.local"));
  });

  it("allows five links an hour per address", async () => {
    const svc = await serviceClient();
    const emailHash = hashForLimit("limit-b@test.local");
    const earlier = Array.from({ length: 5 }, (_, i) => ({
      email_hash: emailHash,
      outcome: "sent",
      created_at: new Date(Date.now() - (5 + i) * 60_000).toISOString(),
    }));
    await svc.from("auth_sign_in_requests").insert(earlier);
    expect(await claim("limit-b@test.local", null)).toBeNull();
    await rows(svc, emailHash);
  });

  it("allows twenty links an hour per IP, across addresses", async () => {
    const svc = await serviceClient();
    const earlier = Array.from({ length: 20 }, (_, i) => ({
      email_hash: hashForLimit(`spread-${i}@test.local`),
      ip_hash: IP,
      outcome: "no_access",
      created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    }));
    await svc.from("auth_sign_in_requests").insert(earlier);
    expect(await claim("fresh@test.local")).toBeNull();
    for (let i = 0; i < 20; i++) await rows(svc, hashForLimit(`spread-${i}@test.local`));
    await rows(svc, hashForLimit("fresh@test.local"));
  });

  it("finds only addresses that hold an MGM role, whatever their case", async () => {
    const svc = await serviceClient();
    const found = await svc.rpc("fn_auth_sign_in_target", { _email: EMAILS[0].toUpperCase() });
    expect(found.data).toBe(MGR.userId);
    expect((await svc.rpc("fn_auth_sign_in_target", { _email: EMAILS[1] })).data).toBeNull();
    expect((await svc.rpc("fn_auth_sign_in_target", { _email: "nobody@test.local" })).data).toBeNull();
  });

  it("is out of reach of signed-in and anonymous callers", async () => {
    const anon = createClient(LOCAL_SUPABASE_URL, testAnonKey() ?? "", { auth: { persistSession: false } });
    for (const client of [MGR.client, anon]) {
      const read = await client.from("auth_sign_in_requests").select("id").limit(1);
      expect(read.data === null || read.data.length === 0).toBe(true);
      for (const [fn, args] of [
        ["fn_auth_claim_sign_in_request", { _email_hash: hashForLimit("x@test.local"), _ip_hash: null }],
        ["fn_auth_sign_in_target", { _email: EMAILS[0] }],
      ] as const) {
        const { data, error } = await client.rpc(fn, args);
        expect(data).toBeNull();
        expect(error).not.toBeNull();
      }
    }
  });

  it("sends a link, and no code, that signs in once, and a second link cancels the first", async () => {
    vi.stubEnv("MGM_APP_URL", "https://mgm.example.org");
    vi.stubEnv("MGM_SMTP_URL", "smtps://mgm:pw@smtp.example.com:465");
    vi.stubEnv("MGM_MAIL_FROM", "MGM <no-reply@example.org>");
    const sent: MailMessage[] = [];
    const transports = new MailTransportRegistry();
    transports.register("smtp", () => ({ send: async (message) => (sent.push(message), { ok: true, messageId: null }) }));
    const svc = await serviceClient();
    const issue = () => issueSignInLink({ service: svc, transports, email: EMAILS[0], ip: null, next: null });

    try {
      expect(await issue()).toBe("sent");
      await svc.from("auth_sign_in_requests").delete().eq("email_hash", hashForLimit(EMAILS[0]));
      expect(await issue()).toBe("sent");
      const hashOf = (m: MailMessage) => /token_hash=([^&\s]+)/.exec(m.text)?.[1] ?? "";
      expect(sent[1].text).toMatch(/^https:\/\/mgm\.example\.org\/auth\/confirm\?token_hash=/m);
      expect(sent[1].text).not.toMatch(/\bcode\b/i);

      const anon = () => createClient(LOCAL_SUPABASE_URL, testAnonKey() ?? "", { auth: { persistSession: false } });
      expect((await anon().auth.verifyOtp({ token_hash: hashOf(sent[0]), type: "email" })).error).not.toBeNull();

      const first = await anon().auth.verifyOtp({ token_hash: hashOf(sent[1]), type: "email" });
      expect(first.error).toBeNull();
      expect(first.data.session?.user.id).toBe(MGR.userId);
      expect((await anon().auth.verifyOtp({ token_hash: hashOf(sent[1]), type: "email" })).error).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it("sends nothing to an address without an MGM role, and creates no account", async () => {
    vi.stubEnv("MGM_APP_URL", "https://mgm.example.org");
    vi.stubEnv("MGM_SMTP_URL", "smtps://mgm:pw@smtp.example.com:465");
    vi.stubEnv("MGM_MAIL_FROM", "no-reply@example.org");
    const sent: MailMessage[] = [];
    const transports = new MailTransportRegistry();
    transports.register("smtp", () => ({ send: async (message) => (sent.push(message), { ok: true, messageId: null }) }));
    const svc = await serviceClient();
    const ghost = `ghost-${Date.now()}@test.local`;
    try {
      expect(await issueSignInLink({ service: svc, transports, email: ghost, ip: null, next: null })).toBe("no_access");
      expect(sent).toHaveLength(0);
      const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
      expect(data.users.some((u) => u.email === ghost)).toBe(false);
    } finally {
      await rows(svc, hashForLimit(ghost));
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
