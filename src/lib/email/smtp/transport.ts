/**
 * The SMTP transport: one message through one organization's mail server.
 *
 * Rules (RFC #186 § 3):
 *   - The name is resolved once (address.ts) and nodemailer connects to that
 *     address; SNI and the certificate check use the name.
 *   - Port 465 is TLS from the first byte; port 587 must upgrade with
 *     STARTTLS (`requireTLS`). Plaintext is never sent, and the certificate
 *     is always verified.
 *   - About 5 s to connect and 10 s for the whole send.
 *   - Failures are reported with fixed copy per reason, never the server's
 *     own text, so nothing it echoes (or the password) reaches the page.
 */
import "server-only";

import nodemailer from "nodemailer";
import type { MailMessage, MailSendResult, MailTransport, SmtpSenderSettings, MailFailureReason } from "../types";
import { resolvePublicAddress, type Lookup } from "./address";

export const CONNECT_TIMEOUT_MS = 5_000;
export const SEND_TIMEOUT_MS = 10_000;

type SendMail = (options: Record<string, unknown>) => Promise<{ messageId?: string }>;

export type SmtpDeps = {
  lookup?: Lookup;
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

/** The failure reason for an error nodemailer (or Node's TLS) raised. */
export function classifySmtpError(error: unknown): MailFailureReason {
  const e = error as { code?: unknown; cause?: { code?: unknown }; responseCode?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const causeCode = typeof e?.cause?.code === "string" ? e.cause.code : "";
  if (code === "EAUTH" || code === "ENOAUTH") return "auth_failed";
  if (code === "ETLS" || code === "EREQUIRETLS" || TLS_CODE.test(causeCode) || TLS_CODE.test(code)) return "tls_failed";
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

export function createSmtpTransport(settings: SmtpSenderSettings, deps: SmtpDeps = {}): MailTransport {
  const create = deps.createTransport ?? ((options) => nodemailer.createTransport(options) as unknown as ReturnType<NonNullable<SmtpDeps["createTransport"]>>);
  return {
    async send(message: MailMessage): Promise<MailSendResult> {
      const resolved = await resolvePublicAddress(settings.host, deps.lookup);
      if (!resolved.ok) return failure(resolved.reason, resolved.message);

      const transport = create({
        host: resolved.address,
        port: settings.port,
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

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), SEND_TIMEOUT_MS);
      });
      try {
        const sent = await Promise.race([
          transport.sendMail({
            from: formatFrom(settings),
            to: message.to,
            ...(settings.replyTo ? { replyTo: settings.replyTo } : {}),
            subject: message.subject,
            text: message.text,
          }),
          timedOut,
        ]);
        if (sent === "timeout") return failure("unreachable");
        return { ok: true, messageId: sent.messageId ?? null };
      } catch (error) {
        return failure(classifySmtpError(error));
      } finally {
        clearTimeout(timer);
        transport.close();
      }
    },
  };
}
