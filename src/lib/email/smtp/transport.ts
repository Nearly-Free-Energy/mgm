/**
 * The SMTP transport: one message through one organization's mail server.
 *
 * Rules (RFC #186 § 3):
 *   - The name is resolved once (address.ts) and nodemailer connects to that
 *     address; SNI and the certificate check use the name.
 *   - Port 465 is TLS from the first byte; port 587 must upgrade with
 *     STARTTLS (`requireTLS`). Plaintext is never sent, and the certificate
 *     is always verified.
 *   - One 10 s deadline covers the whole send, DNS included, and about 5 s
 *     to connect. MGM opens the TCP connection itself (nodemailer's
 *     `getSocket`), so at the deadline it destroys the socket: a send that
 *     was reported as failed cannot finish afterwards.
 *   - Failures are reported with fixed copy per reason, never the server's
 *     own text, so nothing it echoes (or the password) reaches the page.
 */
import "server-only";

import { connect as netConnect } from "node:net";
import nodemailer from "nodemailer";
import type { MailMessage, MailSendResult, MailTransport, SmtpSenderSettings, MailFailureReason } from "../types";
import { resolvePublicAddress, type Lookup } from "./address";

export const CONNECT_TIMEOUT_MS = 5_000;
export const SEND_TIMEOUT_MS = 10_000;

type SendMail = (options: Record<string, unknown>) => Promise<{ messageId?: string }>;

/** The part of a socket the transport uses; tests pass a fake. */
export type PlainSocket = {
  once(event: "connect", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  removeAllListeners(event: "connect" | "error"): unknown;
  destroy(): void;
};

export type SmtpDeps = {
  lookup?: Lookup;
  /** Opens the TCP connection; tests replace it. */
  connect?: (address: string, port: number) => PlainSocket;
  /** Builds nodemailer's transport; tests replace it. */
  createTransport?: (options: Record<string, unknown>) => { sendMail: SendMail; close(): void };
};

const COPY: Record<MailFailureReason, string> = {
  auth_failed: "The mail server refused the username or password.",
  unreachable: "Could not connect to the mail server in time. Check its name and port.",
  tls_failed: "Could not set up a secure connection: the server's certificate did not match its name or could not be verified, or it does not offer TLS on this port.",
  rejected: "The mail server refused the message. Check that it allows sending from this From address.",
  refused_address: "MGM will not connect to that address.",
  error: "The test email could not be sent.",
};

const TLS_CODE = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ALTNAME/i;
// nodemailer reports a failed certificate check as a plain ESOCKET and keeps
// only Node's message ("Hostname/IP does not match certificate's altnames"),
// so socket errors are also read by message. The message is never shown.
const TLS_MESSAGE = /certificate|altnames|self[- ]signed|\bTLS\b|\bSSL\b|handshake/i;

/** The failure reason for an error nodemailer (or Node's TLS) raised. */
export function classifySmtpError(error: unknown): MailFailureReason {
  const e = error as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const causeCode = typeof e?.cause?.code === "string" ? e.cause.code : "";
  const message = typeof e?.message === "string" ? e.message : "";
  if (code === "EAUTH" || code === "ENOAUTH") return "auth_failed";
  if (code === "ETLS" || code === "EREQUIRETLS" || TLS_CODE.test(causeCode) || TLS_CODE.test(code)) return "tls_failed";
  if (code === "ESOCKET" && TLS_MESSAGE.test(message)) return "tls_failed";
  if (code === "EENVELOPE" || code === "EMESSAGE") return "rejected";
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "EDNS" || code === "ESOCKET") return "unreachable";
  return "error";
}

function failure(reason: MailFailureReason, message = COPY[reason]): MailSendResult {
  return { ok: false, reason, message };
}

function formatFrom(settings: SmtpSenderSettings): string | { name: string; address: string } {
  return settings.fromName ? { name: settings.fromName, address: settings.fromAddress } : settings.fromAddress;
}

type GetSocket = (options: unknown, callback: (error: Error | null, socket?: { connection: PlainSocket }) => void) => void;

const timeoutError = (message: string) => Object.assign(new Error(message), { code: "ETIMEDOUT" });

export function createSmtpTransport(settings: SmtpSenderSettings, deps: SmtpDeps = {}): MailTransport {
  const create = deps.createTransport ?? ((options) => nodemailer.createTransport(options) as unknown as ReturnType<NonNullable<SmtpDeps["createTransport"]>>);
  const open = deps.connect ?? ((address: string, port: number) => netConnect({ host: address, port }));
  return {
    async send(message: MailMessage): Promise<MailSendResult> {
      let abandoned = false;
      let socket: PlainSocket | null = null;
      let transport: ReturnType<NonNullable<SmtpDeps["createTransport"]>> | null = null;

      // MGM opens the connection to the address it checked, and keeps it so
      // the deadline can destroy it.
      const getSocket = (address: string): GetSocket => (_options, callback) => {
        if (abandoned) return callback(timeoutError("Send abandoned"));
        const opened = open(address, settings.port);
        socket = opened;
        let settled = false;
        const settle = (error: Error | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(connectTimer);
          opened.removeAllListeners("connect");
          opened.removeAllListeners("error");
          if (error) {
            opened.destroy();
            callback(error);
          } else {
            callback(null, { connection: opened });
          }
        };
        const connectTimer = setTimeout(() => settle(timeoutError("Connection timed out")), CONNECT_TIMEOUT_MS);
        opened.once("connect", () => settle(null));
        opened.once("error", (error) => settle(error ?? new Error("Connection failed")));
      };

      const work = async (): Promise<MailSendResult> => {
        const resolved = await resolvePublicAddress(settings.host, deps.lookup);
        if (!resolved.ok) return failure(resolved.reason, resolved.message);
        if (abandoned) return failure("unreachable");

        transport = create({
          host: resolved.address,
          port: settings.port,
          getSocket: getSocket(resolved.address),
          secure: settings.port === 465,
          requireTLS: settings.port === 587,
          servername: settings.host,
          tls: { servername: settings.host, rejectUnauthorized: true, minVersion: "TLSv1.2" },
          auth: { user: settings.username, pass: settings.password },
          connectionTimeout: CONNECT_TIMEOUT_MS,
          greetingTimeout: CONNECT_TIMEOUT_MS,
          socketTimeout: SEND_TIMEOUT_MS,
          disableFileAccess: true,
          disableUrlAccess: true,
          logger: false,
          debug: false,
        });
        try {
          const sent = await transport.sendMail({
            from: formatFrom(settings),
            to: message.to,
            ...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
            subject: message.subject,
            text: message.text,
          });
          return { ok: true, messageId: sent.messageId ?? null };
        } catch (error) {
          return failure(classifySmtpError(error));
        }
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), SEND_TIMEOUT_MS);
      });
      try {
        const outcome = await Promise.race([work(), deadline]);
        if (outcome !== "timeout") return outcome;
        abandoned = true;
        // Stop the send where it is; a stalled DNS lookup times out on its
        // own (address.ts) and its result is ignored.
        (socket as PlainSocket | null)?.destroy();
        return failure("unreachable");
      } finally {
        clearTimeout(timer);
        (transport as ReturnType<NonNullable<SmtpDeps["createTransport"]>> | null)?.close();
      }
    },
  };
}
