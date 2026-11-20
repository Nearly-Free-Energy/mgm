/**
 * POST /api/tenants/[id]/access — the notice through the real sendNotice
 * (RFC mgm#197 § 6, RFC #186 decisions 1 and 2), with recording transports
 * in place of SMTP: nothing here opens a connection.
 *
 *   - the unit's organization has a sender: the notice goes through it;
 *   - it has none: the deployment's sender sends it;
 *   - the organization's sender fails: the deployment's sends it, and the
 *     failure is recorded on the organization's settings;
 *   - no sender at all, or every send fails: the access stands and the
 *     route answers email_sent: false.
 *
 * The clients, role rows and plugin state are mocked as in route.test.ts;
 * composeCommunityManagement runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { MailMessage, MailSendResult, MailSenderSettings } from "@/lib/email/types";

const TENANT_ID = "7e560000-0000-4000-8005-000000000001";
const MG_ID = "7e560000-0000-4000-8002-000000000001";
const ORG_ID = "7e560000-0000-4000-8000-000000000001";
const MANAGER_ID = "7e560000-0000-4000-8009-000000000001";
const ACCOUNT_ID = "7e560000-0000-4000-8009-000000000010";
const ACCESS_ID = "7e560000-0000-4000-8008-000000000001";

const ORG_HOST = "smtp.org.example.test";
const DEPLOYMENT_HOST = "smtp.deployment.example.test";

type SenderRow = {
  host: string;
  port: number;
  username: string;
  from_address: string;
  from_name: string | null;
  reply_to: string | null;
  version: number;
  last_test_status: string | null;
};

let senderRow: SenderRow | null;
const senderUpdates: Record<string, unknown>[] = [];
const deleteUserSpy = vi.fn();
const grantSpy = vi.fn();

vi.mock("@/lib/supabase/server", () => {
  const maybeSingleOf = (data: unknown) => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }),
  });
  return {
    createClient: async () => ({
      from: (table: string) => {
        if (table === "tenants") return maybeSingleOf({ id: TENANT_ID, microgrid_id: MG_ID });
        if (table === "microgrids") return maybeSingleOf({ id: MG_ID, communities: { org_id: ORG_ID } });
        if (table === "organizations") return maybeSingleOf({ name: "Lakeside Power" });
        throw new Error(`Unexpected table on the caller's client: ${table}`);
      },
      rpc: async (fn: string) => {
        if (fn === "fn_tenant_access_list") return { data: [], error: null };
        throw new Error(`Unexpected RPC on the caller's client: ${fn}`);
      },
      auth: { getUser: async () => ({ data: { user: { id: MANAGER_ID } }, error: null }) },
    }),
  };
});

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    auth: {
      admin: {
        listUsers: async () => ({
          data: { users: [{ id: ACCOUNT_ID, email: "renter@example.test" }] },
          error: null,
        }),
        createUser: async () => {
          throw new Error("An existing account must not be created again");
        },
        deleteUser: async (id: string) => {
          deleteUserSpy(id);
          return { data: {}, error: null };
        },
      },
    },
    rpc: async (fn: string, args: unknown) => {
      if (fn === "fn_tenant_access_grant") {
        grantSpy(args);
        return { data: ACCESS_ID, error: null };
      }
      if (fn === "fn_organization_email_sender_password") return { data: "org-sender-password", error: null };
      throw new Error(`Unexpected RPC on the service client: ${fn}`);
    },
    from: (table: string) => {
      if (table !== "organization_email_senders") {
        throw new Error(`Unexpected table on the service client: ${table}`);
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: senderRow, error: null }) }) }),
        update: (patch: Record<string, unknown>) => {
          senderUpdates.push(patch);
          const chain = { eq: () => chain, then: (resolve: (v: unknown) => void) => resolve({ error: null }) };
          return chain;
        },
      };
    },
  }),
}));

vi.mock("@/lib/auth/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/access")>()),
  getCurrentUserRoles: async () => [{ role: "org_manager", scope_type: "org", scope_id: ORG_ID }],
}));

vi.mock("@/lib/plugins/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugins/state")>()),
  isPluginEnabledForOrg: async () => true,
}));

import { POST } from "../route";
import { getMgmRuntime } from "@/lib/runtime/root";
import { _resetTenantAccessLimiterForTests } from "@/lib/community-management/tenant-access-limit";

/** What each fake server answers, by host; a host not named here delivers. */
let answers: Record<string, MailSendResult>;
const sent: { host: string; message: MailMessage }[] = [];

const UNREACHABLE: MailSendResult = { ok: false, reason: "unreachable", message: "connection refused" };

async function grant() {
  const res = await POST(
    new NextRequest(`http://localhost/api/tenants/${TENANT_ID}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Renter@Example.TEST" }),
    }),
    { params: Promise.resolve({ id: TENANT_ID }) }
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  vi.clearAllMocks();
  _resetTenantAccessLimiterForTests();
  senderUpdates.length = 0;
  sent.length = 0;
  answers = {};
  senderRow = {
    host: ORG_HOST,
    port: 587,
    username: "notices@org.example.test",
    from_address: "notices@org.example.test",
    from_name: "Lakeside Power",
    reply_to: null,
    version: 1,
    last_test_status: "success",
  };
  vi.stubEnv("MGM_APP_URL", "https://mgm.example.test");
  vi.stubEnv("MGM_SMTP_URL", `smtps://mgm:pw@${DEPLOYMENT_HOST}:465`);
  vi.stubEnv("MGM_MAIL_FROM", "MGM <no-reply@deployment.example.test>");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  // The runtime's own registry, with every transport it builds replaced by
  // a recording one.
  const runtime = await getMgmRuntime();
  vi.spyOn(runtime.mailTransports, "create").mockImplementation((settings: MailSenderSettings) => ({
    send: async (message: MailMessage) => {
      sent.push({ host: settings.host, message });
      return answers[settings.host] ?? { ok: true, messageId: null };
    },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const GRANTED = { access_id: ACCESS_ID, email: "renter@example.test" };

describe("POST /api/tenants/[id]/access: the notice through sendNotice", () => {
  it("sends through the organization's own sender when it has one", async () => {
    const out = await grant();

    expect(out).toEqual({ status: 201, body: { ...GRANTED, email_sent: true } });
    expect(sent.map((s) => s.host)).toEqual([ORG_HOST]);
    const [{ message }] = sent;
    expect(message.to).toBe("renter@example.test");
    expect(message.subject).toBe("Lakeside Power gave you access to your electricity use in MGM");
    expect(message.text).toContain("https://mgm.example.test/login");
    expect(`${message.subject}\n${message.text}`).not.toMatch(/token|\/auth\/confirm|otp/i);
  });

  it("sends through the deployment's sender when the organization has none", async () => {
    senderRow = null;
    const out = await grant();

    expect(out).toEqual({ status: 201, body: { ...GRANTED, email_sent: true } });
    expect(sent.map((s) => s.host)).toEqual([DEPLOYMENT_HOST]);
    expect(senderUpdates).toEqual([]);
  });

  it("falls back to the deployment's sender when the organization's fails, and records the failure", async () => {
    answers[ORG_HOST] = UNREACHABLE;
    const out = await grant();

    expect(out).toEqual({ status: 201, body: { ...GRANTED, email_sent: true } });
    expect(sent.map((s) => s.host)).toEqual([ORG_HOST, DEPLOYMENT_HOST]);
    expect(senderUpdates).toHaveLength(1);
    expect(senderUpdates[0]).toMatchObject({ last_test_status: "unreachable" });
  });

  it("keeps the access and answers email_sent: false when there is no sender at all", async () => {
    senderRow = null;
    vi.stubEnv("MGM_SMTP_URL", "");
    const out = await grant();

    expect(out).toEqual({ status: 201, body: { ...GRANTED, email_sent: false } });
    expect(sent).toEqual([]);
    expect(grantSpy).toHaveBeenCalledTimes(1);
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it("keeps the access and answers email_sent: false when every send fails", async () => {
    answers[ORG_HOST] = UNREACHABLE;
    answers[DEPLOYMENT_HOST] = { ok: false, reason: "rejected", message: "550 rejected" };
    const out = await grant();

    expect(out).toEqual({ status: 201, body: { ...GRANTED, email_sent: false } });
    expect(sent.map((s) => s.host)).toEqual([ORG_HOST, DEPLOYMENT_HOST]);
    expect(grantSpy).toHaveBeenCalledTimes(1);
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it("keeps the access and answers email_sent: false when a transport throws", async () => {
    senderRow = null;
    const runtime = await getMgmRuntime();
    vi.mocked(runtime.mailTransports.create).mockImplementation(() => ({
      send: async () => {
        throw new Error("socket closed");
      },
    }));
    const out = await grant();

    expect(out).toEqual({ status: 201, body: { ...GRANTED, email_sent: false } });
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });
});
