import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Call = { table: string; op: string; args: unknown[] };

/** A query builder that records its calls and resolves `result` when awaited. */
function builder(table: string, calls: Call[], result: () => unknown) {
  const query: Record<string, unknown> = {};
  for (const op of ["select", "eq", "update", "insert", "delete"]) {
    query[op] = (...args: unknown[]) => {
      calls.push({ table, op, args });
      return query;
    };
  }
  query.maybeSingle = async () => result();
  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result()).then(resolve, reject);
  return query;
}

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  user: vi.fn(),
  saved: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  write: vi.fn(),
  send: vi.fn(),
  create: vi.fn(),
  userCalls: [] as { table: string; op: string; args: unknown[] }[],
  serviceCalls: [] as { table: string; op: string; args: unknown[] }[],
  service: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/access", () => ({ currentUserCanAccessOrg: mocks.access }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.user },
    from: (table: string) =>
      builder(table, mocks.userCalls, () =>
        table === "organizations" ? { data: { name: "Kiwumu Energy" }, error: null } : mocks.saved()
      ),
    rpc: mocks.encrypt,
  }),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.service }));
vi.mock("@/lib/runtime/root", () => ({
  getMgmRuntime: async () => ({ mailTransports: { create: mocks.create } }),
}));

import { DELETE, GET, PUT } from "../route";

const ORG = "11111111-1111-4111-8111-111111111111";
const SAVED = {
  org_id: ORG,
  host: "smtp.example.com",
  port: 587,
  username: "notices@example.com",
  from_address: "notices@example.com",
  from_name: "Kiwumu Energy",
  reply_to: null,
  version: 3,
  last_tested_at: "2026-11-16T10:00:00Z",
  last_test_status: "success",
  last_test_message: "Test email sent to manager@example.org.",
  created_at: "2026-11-16T09:00:00Z",
  updated_at: "2026-11-16T10:00:00Z",
};
const FORM = {
  host: "smtp.example.com",
  port: 587,
  username: "notices@example.com",
  password: "",
  fromAddress: "notices@example.com",
  fromName: "Kiwumu Energy",
  replyTo: "",
  version: 3,
};
const params = { params: Promise.resolve({ id: ORG }) };

function put(body: unknown) {
  return PUT(
    new NextRequest(`https://mgm.test/api/organizations/${ORG}/email-sender`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params
  );
}

const serviceOps = (op: string) => mocks.serviceCalls.filter((c) => c.op === op);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userCalls.length = 0;
  mocks.serviceCalls.length = 0;
  mocks.access.mockResolvedValue(true);
  mocks.user.mockResolvedValue({ data: { user: { email: "manager@example.org" } } });
  mocks.saved.mockReturnValue({ data: SAVED, error: null });
  mocks.encrypt.mockResolvedValue({ data: "\\xdeadbeef", error: null });
  mocks.decrypt.mockResolvedValue({ data: "saved-password", error: null });
  mocks.write.mockReturnValue({ data: { ...SAVED, version: 4 }, error: null });
  mocks.send.mockResolvedValue({ ok: true, messageId: "<id>" });
  mocks.create.mockReturnValue({ send: mocks.send });
  mocks.service.mockReturnValue({
    rpc: mocks.decrypt,
    from: (table: string) => builder(table, mocks.serviceCalls, () => mocks.write()),
  });
});

describe("GET /api/organizations/[id]/email-sender", () => {
  it("reads only the granted columns, on the caller's client", async () => {
    const response = await GET(new NextRequest("https://mgm.test"), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sender: SAVED });
    const select = mocks.userCalls.find((c) => c.table === "organization_email_senders" && c.op === "select");
    expect(String(select?.args[0])).not.toContain("password");
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it("refuses a caller without access to the organization", async () => {
    mocks.access.mockResolvedValue(false);
    expect((await GET(new NextRequest("https://mgm.test"), params)).status).toBe(403);
  });
});

describe("PUT /api/organizations/[id]/email-sender", () => {
  it("refuses a caller without access before anything is decrypted or sent", async () => {
    mocks.access.mockResolvedValue(false);
    expect((await put({ ...FORM, password: "new" })).status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses an address literal as the host", async () => {
    const response = await put({ ...FORM, host: "203.0.113.5" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: "host" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("saves a first sender only after the test email to the caller is accepted", async () => {
    mocks.saved.mockReturnValue({ data: null, error: null });
    const response = await put({ ...FORM, password: "new-password", version: null });
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "smtp", host: "smtp.example.com", port: 587, password: "new-password" })
    );
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: "manager@example.org" }));
    expect(mocks.encrypt).toHaveBeenCalledWith("fn_ems_encrypt_secret", { p_plaintext: "new-password" });
    const [insert] = serviceOps("insert");
    expect(insert.args[0]).toMatchObject({ org_id: ORG, password_encrypted: "\\xdeadbeef", last_test_status: "success" });
    expect(JSON.stringify(await response.json())).not.toContain("new-password");
  });

  it("needs a password for the first save", async () => {
    mocks.saved.mockReturnValue({ data: null, error: null });
    const response = await put({ ...FORM, version: null });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: "password" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps the saved password while the server and username are unchanged", async () => {
    const response = await put({ ...FORM, fromName: "Kiwumu" });
    expect(response.status).toBe(200);
    expect(mocks.decrypt).toHaveBeenCalledWith("fn_organization_email_sender_password", { _org_id: ORG });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ password: "saved-password" }));
    const [update] = serviceOps("update");
    expect(update.args[0]).toMatchObject({ from_name: "Kiwumu", version: 4 });
    expect(update.args[0]).not.toHaveProperty("password_encrypted");
    expect(mocks.serviceCalls).toContainEqual({ table: "organization_email_senders", op: "eq", args: ["version", 3] });
  });

  it.each([
    ["host", { host: "mail.example.net" }],
    ["port", { port: 465 }],
    ["username", { username: "other@example.com" }],
  ])("needs the password again when the %s changes", async (_name, change) => {
    const response = await put({ ...FORM, ...change });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: "password" });
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 409 without sending when the saved version moved", async () => {
    expect((await put({ ...FORM, version: 2 })).status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 409 when the row changed between the read and the write", async () => {
    mocks.write.mockReturnValue({ data: null, error: null });
    expect((await put(FORM)).status).toBe(409);
  });

  it("saves nothing when the test fails, and records the failure on unchanged saved settings", async () => {
    mocks.send.mockResolvedValue({ ok: false, reason: "auth_failed", message: "The mail server refused the username or password." });
    const response = await put(FORM);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "The mail server refused the username or password.",
      reason: "auth_failed",
    });
    const [update] = serviceOps("update");
    expect(Object.keys(update.args[0] as object).sort()).toEqual(["last_test_message", "last_test_status", "last_tested_at"]);
    expect(serviceOps("insert")).toHaveLength(0);
  });

  it("does not record a failed test of settings that differ from the saved ones", async () => {
    mocks.send.mockResolvedValue({ ok: false, reason: "unreachable", message: "Could not connect." });
    expect((await put({ ...FORM, password: "candidate" })).status).toBe(422);
    expect(serviceOps("update")).toHaveLength(0);
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/organizations/[id]/email-sender", () => {
  it("deletes on the caller's client, under RLS", async () => {
    mocks.saved.mockReturnValue({ data: null, error: null });
    const response = await DELETE(new NextRequest("https://mgm.test", { method: "DELETE" }), params);
    expect(response.status).toBe(200);
    expect(mocks.userCalls).toContainEqual({ table: "organization_email_senders", op: "delete", args: [] });
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it("refuses a caller without access", async () => {
    mocks.access.mockResolvedValue(false);
    expect((await DELETE(new NextRequest("https://mgm.test", { method: "DELETE" }), params)).status).toBe(403);
    expect(mocks.userCalls).toHaveLength(0);
  });
});
