/**
 * Parsing the organization email-sender form (PUT
 * /api/organizations/[id]/email-sender). Client-safe: no server imports, so
 * the settings page can share the limits.
 */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SENDER_PORTS = [465, 587] as const;

/** Header-bound text must not carry a line break (header injection). */
const LINE_BREAK = /[\r\n]/;

export type SenderInput = {
  host: string;
  port: 465 | 587;
  username: string;
  /** Empty means "keep the saved password". */
  password: string;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  /** The version the form loaded; null when no sender was saved yet. */
  version: number | null;
};

export type SenderInputResult =
  | { ok: true; value: SenderInput }
  | { ok: false; field: keyof SenderInput | "body"; error: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Shape checks only. Whether the host is a usable public name is checked by
 * normalizeMailHost and at send time (src/lib/email/smtp/address.ts).
 */
export function parseSenderInput(body: unknown): SenderInputResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, field: "body", error: "Body must be an object." };
  }
  const b = body as Record<string, unknown>;

  const host = text(b.host);
  if (!host) return { ok: false, field: "host", error: "Enter the mail server's name, for example smtp.example.com." };

  const port = b.port;
  if (port !== 465 && port !== 587) {
    return { ok: false, field: "port", error: "Port must be 465 (TLS) or 587 (STARTTLS)." };
  }

  const username = text(b.username);
  if (!username || username.length > 320 || LINE_BREAK.test(username)) {
    return { ok: false, field: "username", error: "Enter the username the mail server expects." };
  }

  // Not trimmed: a password may start or end with a space.
  const password = typeof b.password === "string" ? b.password : "";
  if (password.length > 1024) return { ok: false, field: "password", error: "The password is too long." };

  const fromAddress = text(b.fromAddress);
  if (!EMAIL_RE.test(fromAddress) || fromAddress.length > 320) {
    return { ok: false, field: "fromAddress", error: "Enter the address emails come from, for example notices@example.com." };
  }

  const fromName = text(b.fromName) || null;
  if (fromName && (fromName.length > 120 || LINE_BREAK.test(fromName))) {
    return { ok: false, field: "fromName", error: "The sender name must be one line of at most 120 characters." };
  }

  const replyTo = text(b.replyTo) || null;
  if (replyTo && (!EMAIL_RE.test(replyTo) || replyTo.length > 320)) {
    return { ok: false, field: "replyTo", error: "Enter a valid reply-to address, or leave it blank." };
  }

  const version = b.version;
  if (version !== null && version !== undefined && !(Number.isInteger(version) && (version as number) > 0)) {
    return { ok: false, field: "version", error: "version must be a positive integer or null." };
  }

  return {
    ok: true,
    value: {
      host,
      port,
      username,
      password,
      fromAddress,
      fromName,
      replyTo,
      version: (version as number | null | undefined) ?? null,
    },
  };
}
