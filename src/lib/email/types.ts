/**
 * Mail sending for MGM (RFC #186). A transport sends one message through one
 * configured mail server; transports register by kind into the root
 * `mailTransports` registry (docs/cordis-runtime.md), so an API-based sender
 * is one more platform plugin and callers do not change.
 */

/** A mail server as an organization saves it, with its password decrypted. */
export type SmtpSenderSettings = {
  kind: "smtp";
  /** Lowercase DNS name; never an address literal (see smtp/address.ts). */
  host: string;
  /** 465: TLS from the first byte. 587: STARTTLS, required. */
  port: 465 | 587;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
};

export type MailSenderSettings = SmtpSenderSettings;

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

/** Why a send failed, in the words the settings page and the database use. */
export type MailFailureReason =
  | "auth_failed"
  | "unreachable"
  | "tls_failed"
  | "rejected"
  | "refused_address"
  | "error";

export type MailSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; reason: MailFailureReason; message: string };

export interface MailTransport {
  send(message: MailMessage): Promise<MailSendResult>;
}

export type MailTransportFactory<S extends MailSenderSettings = MailSenderSettings> = (
  settings: S
) => MailTransport;
