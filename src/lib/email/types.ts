/**
 * Mail sending for MGM (RFC #186). A transport sends one message through one
 * configured mail server; transports register by kind into the root
 * `mailTransports` registry (docs/cordis-runtime.md), so an API-based sender
 * is one more platform plugin and callers do not change.
 */

/**
 * A mail server, with its password decrypted: an organization's sender, or
 * the deployment's own (src/lib/config/mail-sender.ts).
 */
export type SmtpSenderSettings = {
  kind: "smtp";
  /** Lowercase DNS name, never an address literal (smtp/address.ts), unless `loopback`. */
  host: string;
  /**
   * 465: TLS from the first byte. Any other port: STARTTLS, required.
   * Organization senders allow 465 and 587 only (sender-input.ts).
   */
  port: number;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  /**
   * Local development only: the deployment sender pointing at the local
   * mail catcher (src/lib/config/mail-sender.ts). The host is a loopback address,
   * the connection is plaintext, and the username may be empty. Never set
   * for an organization's sender.
   */
  loopback?: boolean;
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
