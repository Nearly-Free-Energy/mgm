import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { EventEmitter } from "node:events";
import { CONNECT_TIMEOUT_MS, classifySmtpError, createSmtpTransport, SEND_TIMEOUT_MS } from "../smtp/transport";
import type { SmtpSenderSettings } from "../types";

const SETTINGS: SmtpSenderSettings = {
  kind: "smtp",
  host: "smtp.example.com",
  port: 587,
  username: "notices@example.com",
  password: "s3cret-PASSWORD",
  fromAddress: "notices@example.com",
  fromName: "Kiwumu Energy",
  replyTo: "help@example.com",
};
const MESSAGE = { to: "manager@example.org", subject: "Test", text: "Hello" };
const PUBLIC = async () => [{ address: "142.250.1.27", family: 4 }];

function fakeTransport(sendMail: (options: Record<string, unknown>) => Promise<{ messageId?: string }>) {
  const created: Record<string, unknown>[] = [];
  const close = vi.fn();
  const createTransport = (options: Record<string, unknown>) => {
    created.push(options);
    return { sendMail, close };
  };
  return { created, close, createTransport };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSmtpTransport", () => {
  it("connects to the checked address, with SNI and certificate checks against the name", async () => {
    const fake = fakeTransport(async () => ({ messageId: "<id@example.com>" }));
    const result = await createSmtpTransport(SETTINGS, { lookup: PUBLIC, createTransport: fake.createTransport }).send(MESSAGE);

    expect(result).toEqual({ ok: true, messageId: "<id@example.com>" });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      host: "142.250.1.27",
      port: 587,
      secure: false,
      requireTLS: true,
      servername: "smtp.example.com",
      tls: { servername: "smtp.example.com", rejectUnauthorized: true, minVersion: "TLSv1.2" },
      auth: { user: SETTINGS.username, pass: SETTINGS.password },
      connectionTimeout: 5_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("uses TLS from the first byte on port 465", async () => {
    const fake = fakeTransport(async () => ({}));
    await createSmtpTransport({ ...SETTINGS, port: 465 }, { lookup: PUBLIC, createTransport: fake.createTransport }).send(MESSAGE);
    expect(fake.created[0]).toMatchObject({ port: 465, secure: true, requireTLS: false });
  });

  it("sends from the saved address and name, with the reply-to", async () => {
    const sendMail = vi.fn(async () => ({}));
    const fake = fakeTransport(sendMail);
    await createSmtpTransport(SETTINGS, { lookup: PUBLIC, createTransport: fake.createTransport }).send(MESSAGE);
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: "Kiwumu Energy", address: "notices@example.com" },
      to: MESSAGE.to,
      replyTo: "help@example.com",
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    });
  });

  it("never connects when the name resolves to a non-public address", async () => {
    const fake = fakeTransport(async () => ({}));
    const result = await createSmtpTransport(SETTINGS, {
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
      createTransport: fake.createTransport,
    }).send(MESSAGE);
    expect(result).toMatchObject({ ok: false, reason: "refused_address" });
    expect(fake.created).toHaveLength(0);
  });

  it("reports a failure with fixed copy, never the server's text or the password", async () => {
    const fake = fakeTransport(async () => {
      throw Object.assign(new Error(`535 5.7.8 Bad credentials for ${SETTINGS.password}`), { code: "EAUTH" });
    });
    const result = await createSmtpTransport(SETTINGS, { lookup: PUBLIC, createTransport: fake.createTransport }).send(MESSAGE);
    expect(result).toEqual({ ok: false, reason: "auth_failed", message: "The mail server refused the username or password." });
    expect(JSON.stringify(result)).not.toContain(SETTINGS.password);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("gives up after the send timeout", async () => {
    vi.useFakeTimers();
    const fake = fakeTransport(() => new Promise(() => {}));
    const pending = createSmtpTransport(SETTINGS, { lookup: PUBLIC, createTransport: fake.createTransport }).send(MESSAGE);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "unreachable" });
    expect(fake.close).toHaveBeenCalledOnce();
  });
});

/** A socket that connects when told to, and records whether it was destroyed. */
function fakeSocket() {
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  return socket;
}

type GetSocket = (options: unknown, callback: (error: Error | null, socket?: { connection: unknown }) => void) => void;

describe("createSmtpTransport for the local mail catcher", () => {
  it("connects in plaintext to a loopback host without the public-address check, and without a login", async () => {
    const lookup = vi.fn();
    const fake = fakeTransport(async () => ({}));
    const result = await createSmtpTransport(
      { ...SETTINGS, host: "localhost", port: 54325, username: "", password: "", plaintextLocal: true },
      { lookup, createTransport: fake.createTransport }
    ).send(MESSAGE);
    expect(result).toMatchObject({ ok: true });
    expect(lookup).not.toHaveBeenCalled();
    expect(fake.created[0]).toMatchObject({ host: "127.0.0.1", port: 54325, secure: false, ignoreTLS: true });
    expect(fake.created[0]).not.toHaveProperty("auth");
  });

  it("connects to a container-network name, such as docker compose's mailpit, without the public-address check", async () => {
    const lookup = vi.fn();
    const fake = fakeTransport(async () => ({}));
    await createSmtpTransport(
      { ...SETTINGS, host: "mailpit", port: 1025, username: "", password: "", plaintextLocal: true },
      { lookup, createTransport: fake.createTransport }
    ).send(MESSAGE);
    expect(lookup).not.toHaveBeenCalled();
    expect(fake.created[0]).toMatchObject({ host: "mailpit", port: 1025, secure: false, ignoreTLS: true });
  });

  it.each([
    ["a dotted name", SETTINGS.host],
    ["an all-digit name", "167772161"],
  ])("refuses %s marked plaintextLocal", async (_name, host) => {
    const fake = fakeTransport(async () => ({}));
    const result = await createSmtpTransport({ ...SETTINGS, host, plaintextLocal: true }, { createTransport: fake.createTransport }).send(MESSAGE);
    expect(result).toMatchObject({ ok: false, reason: "refused_address" });
    expect(fake.created).toHaveLength(0);
  });
});

describe("createSmtpTransport deadline", () => {
  it("gives up on a DNS lookup that never answers, inside the same deadline, and never connects", async () => {
    vi.useFakeTimers();
    const fake = fakeTransport(async () => ({}));
    const pending = createSmtpTransport(SETTINGS, {
      lookup: () => new Promise(() => {}),
      createTransport: fake.createTransport,
    }).send(MESSAGE);
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "unreachable" });
    expect(fake.created).toHaveLength(0);
  });

  it("connects to the checked address and destroys the socket at the deadline", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const connect = vi.fn(() => socket);
    const fake = fakeTransport(() => new Promise(() => {}));
    const createTransport = (options: Record<string, unknown>) => {
      // What nodemailer does first: ask for a socket.
      (options.getSocket as GetSocket)({}, () => {});
      return fake.createTransport(options);
    };
    const pending = createSmtpTransport(SETTINGS, { lookup: PUBLIC, connect, createTransport }).send(MESSAGE);
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledWith("142.250.1.27", 587);
    socket.emit("connect");
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "unreachable" });
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("hands nodemailer the socket once it connects, and keeps it after a send that finishes in time", async () => {
    const socket = fakeSocket();
    let handed: unknown;
    const fake = fakeTransport(async () => ({ messageId: "<id>" }));
    const createTransport = (options: Record<string, unknown>) => {
      (options.getSocket as GetSocket)({}, (error, opened) => {
        handed = error ?? opened?.connection;
      });
      socket.emit("connect");
      return fake.createTransport(options);
    };
    const result = await createSmtpTransport(SETTINGS, { lookup: PUBLIC, connect: () => socket, createTransport }).send(MESSAGE);
    expect(result).toMatchObject({ ok: true });
    expect(handed).toBe(socket);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("fails a connection that does not open within the connect timeout, and destroys it", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const errors: (Error | null)[] = [];
    const fake = fakeTransport(() => new Promise(() => {}));
    const createTransport = (options: Record<string, unknown>) => {
      (options.getSocket as GetSocket)({}, (error) => errors.push(error));
      return fake.createTransport(options);
    };
    void createSmtpTransport(SETTINGS, { lookup: PUBLIC, connect: () => socket, createTransport }).send(MESSAGE);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "ETIMEDOUT" });
    expect(socket.destroy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
  });
});

describe("classifySmtpError", () => {
  it.each([
    [{ code: "EAUTH" }, "auth_failed"],
    [{ code: "ENOAUTH" }, "auth_failed"],
    [{ code: "ETLS" }, "tls_failed"],
    [{ code: "ESOCKET", cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }, "tls_failed"],
    [{ code: "ESOCKET", cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } }, "tls_failed"],
    // As nodemailer 10 reports a name mismatch (seen against a live server).
    [{ code: "ESOCKET", message: "Hostname/IP does not match certificate's altnames: Host: smtp.example.com. is not in the cert's altnames: DNS:smtp.gmail.com" }, "tls_failed"],
    [{ code: "ESOCKET", message: "self-signed certificate" }, "tls_failed"],
    [{ code: "ESOCKET", message: "connect ECONNREFUSED 142.250.1.27:587" }, "unreachable"],
    [{ code: "EENVELOPE" }, "rejected"],
    [{ code: "EMESSAGE" }, "rejected"],
    [{ code: "ETIMEDOUT" }, "unreachable"],
    [{ code: "ECONNECTION" }, "unreachable"],
    [{ code: "ESOCKET" }, "unreachable"],
    [{}, "error"],
    [null, "error"],
  ])("classifies %j as %s", (error, reason) => {
    expect(classifySmtpError(error)).toBe(reason);
  });
});
