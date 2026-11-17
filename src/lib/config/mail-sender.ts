import "server-only";
/**
 * The deployment's own mail sender (RFC #186): the only sender that carries
 * sign-in links and codes (decision 5), and the one notices fall back to
 * when an organization has none (decisions 1 and 2).
 *
 *   MGM_SMTP_URL   smtps://user:password@smtp.example.com:465
 *                  smtp://user:password@smtp.example.com:587   (STARTTLS required)
 *                  smtp://127.0.0.1:54325   local mail catcher, plaintext;
 *                                           allowed only on a loopback host
 *   MGM_MAIL_FROM  MGM <no-reply@example.com>, or a bare address
 *
 * Read per call, like MGM_APP_URL (app-url.ts), and errors name the variable
 * without echoing it: the URL holds the mail password. The URL's user and
 * password are percent-decoded, so a password with "@" or "/" is written
 * percent-encoded.
 */
import type { SmtpSenderSettings } from "@/lib/email/types";
import { normalizeMailHost } from "@/lib/email/smtp/address";
import { RuntimeConfigError, type RuntimeEnv } from "./public-runtime-config";

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseFrom(value: string): { fromAddress: string; fromName: string | null } {
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  const fromName = named ? named[1].replace(/^"|"$/g, "").trim() || null : null;
  const fromAddress = (named ? named[2] : value).trim();
  if (!EMAIL_RE.test(fromAddress) || /[\r\n]/.test(value)) {
    throw new RuntimeConfigError("MGM_MAIL_FROM must be an email address, optionally as Name <address>.");
  }
  return { fromAddress, fromName };
}

/** Pure parser: the deployment sender's settings. */
export function parseDeploymentSender(env: RuntimeEnv): SmtpSenderSettings {
  const raw = present(env.MGM_SMTP_URL);
  const from = present(env.MGM_MAIL_FROM);
  if (!raw || !from) {
    throw new RuntimeConfigError(
      "Missing required runtime configuration: MGM_SMTP_URL and MGM_MAIL_FROM. " +
        'See docs/setup.md, section "Runtime configuration".'
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RuntimeConfigError("MGM_SMTP_URL is not a valid URL.");
  }
  if (url.pathname.replace(/^\/+/, "") || url.search || url.hash) {
    throw new RuntimeConfigError("MGM_SMTP_URL must not have a path, query or fragment.");
  }

  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  let port: number;
  if (url.protocol === "smtps:") {
    port = Number(url.port || 465);
  } else if (url.protocol === "smtp:") {
    port = Number(url.port || 587);
  } else {
    throw new RuntimeConfigError("MGM_SMTP_URL must use smtps:// or smtp://.");
  }

  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const { fromAddress, fromName } = parseFrom(from);

  if (loopback && url.protocol === "smtp:") {
    // The local mail catcher: plaintext, on this machine only.
    return {
      kind: "smtp",
      host: url.hostname === "[::1]" ? "::1" : url.hostname,
      port,
      username,
      password,
      fromAddress,
      fromName,
      replyTo: null,
      loopback: true,
    };
  }

  const host = normalizeMailHost(url.hostname);
  if (!host) {
    throw new RuntimeConfigError(
      "MGM_SMTP_URL must name its mail server by a public DNS name (plaintext smtp:// is allowed only for localhost)."
    );
  }
  if (url.protocol === "smtps:" && port !== 465) {
    throw new RuntimeConfigError("MGM_SMTP_URL: smtps:// is TLS from the first byte, on port 465.");
  }
  if (!username || !password) {
    throw new RuntimeConfigError("MGM_SMTP_URL must include the mail server's username and password.");
  }
  return { kind: "smtp", host, port, username, password, fromAddress, fromName, replyTo: null };
}

function readEnv(): RuntimeEnv {
  return { MGM_SMTP_URL: process.env.MGM_SMTP_URL, MGM_MAIL_FROM: process.env.MGM_MAIL_FROM };
}

/** The deployment sender for this request; throws RuntimeConfigError when unset or invalid. */
export function getDeploymentSender(env: RuntimeEnv = readEnv()): SmtpSenderSettings {
  return parseDeploymentSender(env);
}
