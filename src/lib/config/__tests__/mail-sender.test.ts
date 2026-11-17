import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseDeploymentSender } from "../mail-sender";

const FROM = "MGM <no-reply@example.com>";

describe("parseDeploymentSender", () => {
  it("reads an implicit-TLS server with percent-encoded credentials", () => {
    expect(
      parseDeploymentSender({ MGM_SMTP_URL: "smtps://mgm%40example.com:p%2Fw%40rd@SMTP.Example.com:465", MGM_MAIL_FROM: FROM })
    ).toEqual({
      kind: "smtp",
      host: "smtp.example.com",
      port: 465,
      username: "mgm@example.com",
      password: "p/w@rd",
      fromAddress: "no-reply@example.com",
      fromName: "MGM",
      replyTo: null,
    });
  });

  it("defaults smtp:// to port 587, where STARTTLS is required", () => {
    expect(parseDeploymentSender({ MGM_SMTP_URL: "smtp://u:p@smtp.example.com", MGM_MAIL_FROM: "no-reply@example.com" })).toMatchObject({
      port: 587,
      fromName: null,
      fromAddress: "no-reply@example.com",
    });
  });

  it("allows plaintext only to the local mail catcher", () => {
    expect(parseDeploymentSender({ MGM_SMTP_URL: "smtp://127.0.0.1:54325", MGM_MAIL_FROM: FROM })).toMatchObject({
      host: "127.0.0.1",
      port: 54325,
      username: "",
      plaintextLocal: true,
    });
  });

  it("allows plaintext to a container-network name with no dot only when opted in, for docker compose's mail catcher", () => {
    const env = { MGM_SMTP_URL: "smtp://MailPit:1025", MGM_MAIL_FROM: FROM };
    expect(() => parseDeploymentSender(env)).toThrow("MGM_SMTP_ALLOW_PLAINTEXT_LOCAL=1");
    expect(() => parseDeploymentSender({ ...env, MGM_SMTP_ALLOW_PLAINTEXT_LOCAL: "true" })).toThrow("MGM_SMTP_ALLOW_PLAINTEXT_LOCAL=1");
    expect(parseDeploymentSender({ ...env, MGM_SMTP_ALLOW_PLAINTEXT_LOCAL: "1" })).toMatchObject({
      host: "mailpit",
      port: 1025,
      plaintextLocal: true,
    });
  });

  it("refuses an all-digit name, which a resolver may read as an IPv4 address, even when opted in", () => {
    expect(() =>
      parseDeploymentSender({ MGM_SMTP_URL: "smtp://167772161:25", MGM_MAIL_FROM: FROM, MGM_SMTP_ALLOW_PLAINTEXT_LOCAL: "1" })
    ).toThrow("public DNS name");
  });

  it("lowercases the host, which smtp:// URLs keep as written", () => {
    expect(parseDeploymentSender({ MGM_SMTP_URL: "smtp://LOCALHOST:54325", MGM_MAIL_FROM: FROM })).toMatchObject({
      host: "localhost",
      plaintextLocal: true,
    });
    expect(parseDeploymentSender({ MGM_SMTP_URL: "smtp://u:p@SMTP.Example.com", MGM_MAIL_FROM: FROM })).toMatchObject({
      host: "smtp.example.com",
    });
  });

  it.each([
    [{}, "Missing required runtime configuration"],
    [{ MGM_SMTP_URL: "smtps://u:p@smtp.example.com" }, "MGM_MAIL_FROM"],
    [{ MGM_SMTP_URL: "https://smtp.example.com", MGM_MAIL_FROM: FROM }, "smtps:// or smtp://"],
    [{ MGM_SMTP_URL: "smtps://u:p@10.0.0.5:465", MGM_MAIL_FROM: FROM }, "public DNS name"],
    [{ MGM_SMTP_URL: "smtps://u:p@smtp.example.com:587", MGM_MAIL_FROM: FROM }, "port 465"],
    [{ MGM_SMTP_URL: "smtps://smtp.example.com", MGM_MAIL_FROM: FROM }, "username and password"],
    [{ MGM_SMTP_URL: "smtps://u:p@smtp.example.com/x", MGM_MAIL_FROM: FROM }, "path"],
    [{ MGM_SMTP_URL: "smtps://u:p@smtp.example.com", MGM_MAIL_FROM: "not an address" }, "MGM_MAIL_FROM"],
  ])("refuses %j", (env, message) => {
    expect(() => parseDeploymentSender(env)).toThrow(message);
  });

  it("never echoes the URL, which holds the password", () => {
    try {
      parseDeploymentSender({ MGM_SMTP_URL: "smtps://u:hunter2@10.0.0.5:465", MGM_MAIL_FROM: FROM });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("hunter2");
    }
  });
});
