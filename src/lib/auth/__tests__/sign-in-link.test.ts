import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { hashForLimit, issueSignInLink, requestIp, signInEmail } from "../sign-in-link";
import type { MailTransportRegistry } from "@/lib/runtime/services";

const ENV = {
  MGM_APP_URL: "https://mgm.example.org",
  MGM_SMTP_URL: "smtps://mgm:pw@smtp.example.com:465",
  MGM_MAIL_FROM: "MGM <no-reply@example.org>",
};

const mocks = {
  rpc: vi.fn(),
  update: vi.fn(),
  generateLink: vi.fn(),
  send: vi.fn(),
  create: vi.fn(),
};

function service() {
  return {
    rpc: mocks.rpc,
    from: () => ({ update: (row: unknown) => ({ eq: (_c: string, id: unknown) => mocks.update(row, id) }) }),
    auth: { admin: { generateLink: mocks.generateLink } },
  } as never;
}
const transports = { create: mocks.create } as unknown as MailTransportRegistry;

function issue(email = "Manager@Example.org", next: string | null = "/microgrids/abc") {
  return issueSignInLink({ service: service(), transports, email, ip: "203.0.113.9", next });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  mocks.rpc.mockImplementation(async (name: string) =>
    name === "fn_auth_claim_sign_in_request" ? { data: 41, error: null } : { data: "user-id", error: null }
  );
  mocks.update.mockResolvedValue({ error: null });
  mocks.generateLink.mockResolvedValue({
    data: { properties: { hashed_token: "HASHED", email_otp: "123456" } },
    error: null,
  });
  mocks.send.mockResolvedValue({ ok: true, messageId: "<id>" });
  mocks.create.mockReturnValue({ send: mocks.send });
});

describe("issueSignInLink", () => {
  it("claims the limit with hashes, never the address or IP", async () => {
    await issue();
    expect(mocks.rpc).toHaveBeenCalledWith("fn_auth_claim_sign_in_request", {
      _email_hash: hashForLimit("manager@example.org"),
      _ip_hash: hashForLimit("203.0.113.9"),
    });
    expect(JSON.stringify(mocks.rpc.mock.calls[0])).not.toContain("manager");
  });

  it("does nothing more when the limit is used up", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(issue()).resolves.toBe("limited");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.generateLink).not.toHaveBeenCalled();
  });

  it("never asks for a token for an address without an MGM role", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "fn_auth_claim_sign_in_request" ? { data: 41, error: null } : { data: null, error: null }
    );
    await expect(issue()).resolves.toBe("no_access");
    expect(mocks.generateLink).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({ outcome: "no_access" }, 41);
  });

  it("sends the link and code through the deployment sender, with the link on MGM_APP_URL", async () => {
    await expect(issue()).resolves.toBe("sent");
    expect(mocks.generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "manager@example.org" });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.example.com", port: 465 }));
    const message = mocks.send.mock.calls[0][0];
    expect(message.to).toBe("manager@example.org");
    expect(message.text).toContain("https://mgm.example.org/auth/confirm?token_hash=HASHED&next=%2Fmicrogrids%2Fabc");
    expect(message.text).toContain("123456");
    expect(mocks.update).toHaveBeenCalledWith({ outcome: "sent" }, 41);
  });

  it("drops a return path that leaves the site", async () => {
    await issue("manager@example.org", "https://evil.example/");
    expect(mocks.send.mock.calls[0][0].text).toContain("/auth/confirm?token_hash=HASHED\n");
  });

  it("issues no token when the deployment has no mail sender", async () => {
    vi.stubEnv("MGM_SMTP_URL", "");
    await expect(issue()).resolves.toBe("send_failed");
    expect(mocks.generateLink).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({ outcome: "send_failed" }, 41);
  });

  it("records a failed send", async () => {
    mocks.send.mockResolvedValue({ ok: false, reason: "unreachable", message: "x" });
    await expect(issue()).resolves.toBe("send_failed");
    expect(mocks.update).toHaveBeenCalledWith({ outcome: "send_failed" }, 41);
  });

  it("logs outcomes only, never the address, link or code", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await issue();
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain("sent");
    for (const secret of ["manager", "HASHED", "123456"]) expect(logged).not.toContain(secret);
    info.mockRestore();
  });
});

describe("signInEmail", () => {
  it("says how long the link lasts and that a new one cancels it", () => {
    const { text, subject } = signInEmail({ to: "a@example.org", link: "https://x/y", code: "654321" });
    expect(subject).toBe("Your MGM sign-in link");
    expect(text).toContain("15 minutes");
    expect(text).toContain("cancels");
  });
});

describe("requestIp", () => {
  it("takes the first forwarded address", () => {
    expect(requestIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(requestIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(requestIp(new Headers())).toBeNull();
  });
});
